import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type VendorEntry, loadKnowledgeBase } from '@egressa/kb';
import { describe, expect, it } from 'vitest';
import { FactsError, checkFacts, loadFacts, parseFacts } from './load.js';

const kb = loadKnowledgeBase({ kbPath: 'kb' });
const NOW = new Date('2026-11-03T12:00:00Z');
const SENTINEL = 'SENTINEL c0ffee';

const dpfFact = (edit: (f: Record<string, unknown>) => void = () => {}) => {
  const fact: Record<string, unknown> = {
    vendor: 'notion',
    fact: 'dpf',
    value: {
      observedStatus: 'Active',
      organizationName: 'Notion Labs, Inc.',
      participantUrl: 'https://www.dataprivacyframework.gov/participant/6134',
    },
    source: {
      url: 'https://www.dataprivacyframework.gov/participant/6134',
      retrievedAt: '2026-11-01',
    },
    verifiedBy: 'agent for A Person',
  };
  edit(fact);
  return fact;
};
const doc = (facts: unknown[] = [], localVendors?: unknown[]) =>
  JSON.stringify({ version: 1, facts, ...(localVendors ? { localVendors } : {}) }, null, 2);
const check = (text: string, now = NOW) => checkFacts(parseFacts(text, 'facts.json'), kb, now);
const states = (text: string, now = NOW) =>
  check(text, now).items.map((i) => `${i.at}:${i.state}${i.reason ? `:${i.reason}` : ''}`);

function repoWith(write: (dir: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'egressa-facts-'));
  mkdirSync(join(root, '.egressa'));
  write(join(root, '.egressa'));
  return root;
}

describe('loadFacts: the file is untrusted input', () => {
  it('returns null when there is no file, which is the normal case', () => {
    expect(loadFacts(mkdtempSync(join(tmpdir(), 'egressa-facts-')))).toBeNull();
  });

  it('refuses a link that leaves the repository, without reading it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'egressa-outside-'));
    writeFileSync(join(outside, 'secret.json'), `{"version":1,"x":"${SENTINEL}"}`);
    const root = repoWith((dir) =>
      symlinkSync(join(outside, 'secret.json'), join(dir, 'facts.json')),
    );
    expect(() => loadFacts(root)).toThrow(/resolves outside the repository/);
  });

  it('refuses a linked .egressa directory that leaves the repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'egressa-outside-'));
    writeFileSync(join(outside, 'facts.json'), doc());
    const root = mkdtempSync(join(tmpdir(), 'egressa-facts-'));
    symlinkSync(outside, join(root, '.egressa'));
    expect(() => loadFacts(root)).toThrow(/resolves outside the repository/);
  });

  it('refuses a FIFO without blocking, a directory, and a dangling link', () => {
    expect(() =>
      loadFacts(repoWith((dir) => execFileSync('mkfifo', [join(dir, 'facts.json')]))),
    ).toThrow(/not a regular file/);
    expect(() => loadFacts(repoWith((dir) => mkdirSync(join(dir, 'facts.json'))))).toThrow(
      /is a directory/,
    );
    expect(() =>
      loadFacts(repoWith((dir) => symlinkSync(join(dir, 'missing'), join(dir, 'facts.json')))),
    ).toThrow(/does not resolve/);
  });

  it('refuses a file over the size cap and one that is not UTF-8', () => {
    expect(() =>
      loadFacts(
        repoWith((dir) => writeFileSync(join(dir, 'facts.json'), ' '.repeat(9 * 1_048_576))),
      ),
    ).toThrow(/larger than 8 MB/);
    expect(() =>
      loadFacts(
        repoWith((dir) => writeFileSync(join(dir, 'facts.json'), Buffer.from([0xff, 0xfe, 0x7b]))),
      ),
    ).toThrow(/UTF-16/);
    expect(() =>
      loadFacts(
        repoWith((dir) => writeFileSync(join(dir, 'facts.json'), Buffer.from([0x7b, 0xc3, 0x28]))),
      ),
    ).toThrow(/not valid UTF-8/);
  });

  it('names the file by its repository path, never the absolute one', () => {
    const root = repoWith((dir) => writeFileSync(join(dir, 'facts.json'), '{'));
    expect(() => loadFacts(root)).toThrow(/^\.egressa\/facts\.json: /);
    try {
      loadFacts(root);
    } catch (error) {
      expect((error as Error).message).not.toContain(root);
    }
  });

  it('reads a well-formed file', () => {
    const root = repoWith((dir) => writeFileSync(join(dir, 'facts.json'), doc([dpfFact()])));
    expect(loadFacts(root)?.items.map((i) => i.kind)).toEqual(['fact']);
  });
});

describe('parseFacts: strict JSON, and nothing quoted back', () => {
  it.each([
    ['a comment', `{"version": 1 /* ${SENTINEL} */}`, /not valid JSON/],
    ['a trailing comma', `{"version": 1, "facts": [],}`, /not valid JSON/],
    [
      'a repeated key',
      `{"version": 1, "facts": [], "facts": [{"x": "${SENTINEL}"}]}`,
      /repeated key/,
    ],
    ['a prototype key', `{"version": 1, "__proto__": {"x": "${SENTINEL}"}}`, /reserved key/],
    ['an unknown top-level key', `{"version": 1, "${SENTINEL}": 1}`, /additional property/],
    ['a wrong version', `{"version": 2}`, /constant 1/],
    ['a list at the top', `[{"x": "${SENTINEL}"}]`, /must be object/],
    ['an empty file', '', /not valid JSON/],
  ])('refuses %s as a whole-file error', (_, text, pattern) => {
    expect(() => parseFacts(text, 'facts.json')).toThrow(FactsError);
    expect(() => parseFacts(text, 'facts.json')).toThrow(pattern);
    try {
      parseFacts(text, 'facts.json');
    } catch (error) {
      expect((error as Error).message).not.toContain(SENTINEL);
    }
  });

  it('names the line of a repeated key', () => {
    expect(() => parseFacts('{\n"version": 1,\n"version": 1\n}', 'f')).toThrow(/at line 3/);
  });

  it('rejects one malformed fact and keeps the rest', () => {
    const text = doc([{ vendor: 'notion', [SENTINEL]: 1 }, dpfFact()]);
    expect(states(text)).toEqual([
      "facts[0]:rejected:(top level) must NOT have additional property '(not shown)'",
      'facts[1]:current',
    ]);
    expect(JSON.stringify(check(text))).not.toContain(SENTINEL);
  });
});

describe('checkFacts: per-fact rules', () => {
  it('accepts a fact and states when it stops counting', () => {
    const [item] = check(doc([dpfFact()])).items;
    expect(item).toMatchObject({ state: 'current', vendor: 'notion', expiresOn: '2026-12-01' });
  });

  it('expires a fact 30 days after it was read, on the UTC day boundary', () => {
    const text = doc([dpfFact()]);
    expect(states(text, new Date('2026-11-30T23:59:59Z'))).toEqual(['facts[0]:current']);
    expect(states(text, new Date('2026-12-01T00:00:00Z'))).toEqual(['facts[0]:expired']);
  });

  it('honours an earlier stated expiry and refuses a later one', () => {
    const early = dpfFact((f) => {
      f.expires = '2026-11-10';
    });
    expect(check(doc([early])).items[0]?.expiresOn).toBe('2026-11-10');
    const late = dpfFact((f) => {
      f.expires = '2026-12-02';
    });
    expect(states(doc([late]))).toEqual([
      'facts[0]:rejected:expires more than 30 days after retrievedAt',
    ]);
  });

  it('refuses a reading dated in the future', () => {
    const future = dpfFact((f) => {
      f.source = {
        url: 'https://www.dataprivacyframework.gov/participant/6134',
        retrievedAt: '2026-11-05',
      };
    });
    expect(states(doc([future]))).toEqual(['facts[0]:rejected:retrievedAt is in the future']);
  });

  it("accepts today's date written east of UTC, before UTC reaches it", () => {
    const tomorrowUtc = dpfFact((f) => {
      f.source = {
        url: 'https://www.dataprivacyframework.gov/participant/6134',
        retrievedAt: '2026-11-04',
      };
    });
    // 22:30 UTC on the 3rd is already the 4th from UTC+2 eastward.
    expect(states(doc([tomorrowUtc]), new Date('2026-11-03T22:30:00Z'))).toEqual([
      'facts[0]:current',
    ]);
    expect(states(doc([tomorrowUtc]), new Date('2026-11-03T09:00:00Z'))).toEqual([
      'facts[0]:rejected:retrievedAt is in the future',
    ]);
  });

  it.each([
    [
      'an http source',
      (f: Record<string, unknown>) => {
        f.source = {
          url: 'http://www.dataprivacyframework.gov/participant/6134',
          retrievedAt: '2026-11-01',
        };
      },
    ],
    [
      'a dpf source off the DPF site',
      (f: Record<string, unknown>) => {
        f.source = { url: 'https://notion.so/dpf', retrievedAt: '2026-11-01' };
      },
    ],
    [
      'a participant URL off the DPF site',
      (f: Record<string, unknown>) => {
        (f.value as Record<string, unknown>).participantUrl =
          'https://example.org/participant/6134';
      },
    ],
    [
      'no observed status',
      (f: Record<string, unknown>) => {
        (f.value as Record<string, unknown>).observedStatus = undefined;
      },
    ],
    [
      'no retrieval date',
      (f: Record<string, unknown>) => {
        f.source = { url: 'https://www.dataprivacyframework.gov/participant/6134' };
      },
    ],
    [
      'a status longer than 100 characters',
      (f: Record<string, unknown>) => {
        (f.value as Record<string, unknown>).observedStatus = 'A'.repeat(101);
      },
    ],
    [
      'a control character',
      (f: Record<string, unknown>) => {
        f.verifiedBy = 'agent\u0007';
      },
    ],
    [
      'no verifiedBy',
      (f: Record<string, unknown>) => {
        f.verifiedBy = undefined;
      },
    ],
  ])('rejects %s', (_, edit) => {
    expect(check(doc([dpfFact(edit)])).items[0]?.state).toBe('rejected');
  });

  it('rejects a vendor that is neither shipped nor local, and quotes nothing', () => {
    const text = doc([
      dpfFact((f) => {
        f.vendor = 'no-such-vendor';
      }),
    ]);
    expect(states(text)).toEqual([
      'facts[0]:rejected:names a vendor that is neither in the knowledge base nor a local vendor in this file',
    ]);
  });

  it('rejects a forbidden claim word in any field', () => {
    const text = doc([
      dpfFact((f) => {
        f.verifiedBy = 'checked: fully compliant';
      }),
    ]);
    expect(check(text).items[0]?.state).toBe('rejected');
  });

  it('rejects a second fact of the same kind for the same vendor', () => {
    expect(states(doc([dpfFact(), dpfFact()]))).toEqual([
      'facts[0]:current',
      'facts[1]:rejected:repeats facts[0] for the same vendor and fact',
    ]);
  });

  it('keeps an unrecognised status, which reads as not certified, rather than refusing it', () => {
    const odd = dpfFact((f) => {
      (f.value as Record<string, unknown>).observedStatus = 'Pending';
    });
    expect(states(doc([odd]))).toEqual(['facts[0]:current']);
  });

  it('accepts acceptQualifiedStatus only on the qualified status', () => {
    const accepted = (status: string) =>
      dpfFact((f) => {
        (f.value as Record<string, unknown>).observedStatus = status;
        f.acceptQualifiedStatus = { acceptedBy: 'A Person', reason: 'checked with the vendor' };
      });
    expect(states(doc([accepted('Active - Re-certification under Review')]))).toEqual([
      'facts[0]:current',
    ]);
    expect(check(doc([accepted('Active')])).items[0]?.state).toBe('rejected');
  });

  it('ties not-listed to the list, and a listed status to a participant record', () => {
    const notListed = (url: string) =>
      dpfFact((f) => {
        f.value = { observedStatus: 'not-listed', organizationName: 'OpenAI', participantUrl: url };
        f.vendor = 'openai';
        f.source = { url: 'https://www.dataprivacyframework.gov/list', retrievedAt: '2026-11-01' };
      });
    expect(states(doc([notListed('https://www.dataprivacyframework.gov/list')]))).toEqual([
      'facts[0]:current',
    ]);
    expect(
      check(doc([notListed('https://www.dataprivacyframework.gov/participant/1')])).items[0]?.state,
    ).toBe('rejected');
  });

  it('checks dpa and sub-processor values against their own shapes', () => {
    const dpa = (value: unknown) => ({
      vendor: 'stripe',
      fact: 'dpa',
      value,
      source: { url: 'https://stripe.com/legal/dpa', retrievedAt: '2026-11-01' },
      verifiedBy: 'A Person',
    });
    expect(states(doc([dpa({ available: true, url: 'https://stripe.com/legal/dpa' })]))).toEqual([
      'facts[0]:current',
    ]);
    expect(check(doc([dpa({ url: 'https://stripe.com/legal/dpa' })])).items[0]?.state).toBe(
      'rejected',
    );
  });
});

describe('checkFacts: local vendors', () => {
  const draft = (edit: (e: VendorEntry) => void = () => {}): VendorEntry => {
    const e = JSON.parse(readFileSync('kb/vendors/stripe.json', 'utf8')) as VendorEntry;
    e.id = 'acme-geo';
    e.name = 'Acme Geo';
    e.aliases = {
      packages: {},
      hosts: [{ pattern: 'api.acme-geo.example', match: 'exact', purpose: 'api' }],
    } as VendorEntry['aliases'];
    edit(e);
    return e;
  };
  const local = (entry: VendorEntry) => ({
    entry,
    retrievedAt: '2026-11-01',
    verifiedBy: 'A Person',
  });

  it('accepts a clean draft, and a fact about it in the same file', () => {
    const fact = dpfFact((f) => {
      f.vendor = 'acme-geo';
    });
    expect(states(doc([fact], [local(draft())]))).toEqual([
      'localVendors[0]:current',
      'facts[0]:current',
    ]);
  });

  it('refuses a draft reusing a shipped id or a shipped host', () => {
    expect(
      states(
        doc(
          [],
          [
            local(
              draft((e) => {
                e.id = 'stripe';
              }),
            ),
          ],
        ),
      )[0],
    ).toMatch(/rejected:reuses the id of a shipped vendor/);
    expect(
      states(
        doc(
          [],
          [
            local(
              draft((e) => {
                e.aliases.hosts = [
                  { pattern: 'api.stripe.com', match: 'exact', purpose: 'api' } as never,
                ];
              }),
            ),
          ],
        ),
      )[0],
    ).toMatch(/already claimed by "stripe"/);
  });

  it('refuses a draft failing the vendor schema, without quoting it', () => {
    const bad = draft((e) => {
      (e as unknown as Record<string, unknown>)[SENTINEL] = 1;
    });
    const out = check(doc([], [local(bad)]));
    expect(out.items[0]?.state).toBe('rejected');
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('does not quote an unconstrained package name back', () => {
    const bad = draft((e) => {
      e.aliases.packages.npm = [
        { name: `${SENTINEL} with spaces/*`, kind: 'official-sdk' } as never,
      ];
    });
    const out = check(doc([], [local(bad)]));
    expect(out.items[0]?.state).toBe('rejected');
    expect(out.items[0]?.reason).not.toContain(SENTINEL);
  });
});
