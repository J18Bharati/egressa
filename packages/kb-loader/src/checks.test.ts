import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collisionIssues, entryIssues } from './checks.js';
import type { VendorEntry } from './types.js';

const read = (id: string): VendorEntry =>
  JSON.parse(readFileSync(join('kb/vendors', `${id}.json`), 'utf8')) as VendorEntry;
const shipped = readdirSync('kb/vendors')
  .filter((f) => f.endsWith('.json'))
  .map((f) => read(f.slice(0, -5)));

/** A shipped entry under a new id, with every alias removed so it collides with nothing. */
function draft(edit: (e: VendorEntry) => void = () => {}): VendorEntry {
  const e = structuredClone(read('stripe'));
  e.id = 'draft-vendor';
  e.aliases = {
    packages: {},
    hosts: [{ pattern: 'api.draft-vendor.example', match: 'exact', purpose: 'api' }],
  } as VendorEntry['aliases'];
  edit(e);
  return e;
}
const messages = (issues: { message: string }[]) => issues.map((i) => i.message);

describe('entryIssues', () => {
  it('passes every shipped entry', () => {
    expect(shipped.flatMap(entryIssues)).toEqual([]);
  });

  it('passes a clean draft', () => {
    expect(entryIssues(draft())).toEqual([]);
  });

  it.each([
    [
      'no vendor or regulator source',
      (e: VendorEntry) => {
        for (const s of e.sources) s.publisher = 'other' as never;
      },
      /needs at least one source/,
    ],
    [
      'a wildcard alias that is not kind scope',
      (e: VendorEntry) => {
        e.aliases.packages.npm = [{ name: '@draft/*', kind: 'official-sdk' } as never];
      },
      /must be kind "scope"/,
    ],
    [
      'a pypi alias not in PEP 503 form',
      (e: VendorEntry) => {
        e.aliases.packages.pypi = [{ name: 'Draft_SDK', kind: 'official-sdk' } as never];
      },
      /PEP 503/,
    ],
    [
      'a host pattern with one label',
      (e: VendorEntry) => {
        e.aliases.hosts = [{ pattern: 'com', match: 'suffix', purpose: 'api' } as never];
      },
      /too few labels/,
    ],
    [
      'evaluative language in a note',
      (e: VendorEntry) => {
        e.notes = 'This vendor is risky.';
      },
      /evaluative language "risky"/,
    ],
  ])('refuses %s', (_, edit, pattern) => {
    expect(messages(entryIssues(draft(edit))).some((m) => pattern.test(m))).toBe(true);
  });

  it('refuses a certification end date on anything but a DPF record', () => {
    const e = draft((d) => {
      d.legal.transferMechanisms = [{ mechanism: 'SCC', certificationEndDate: '2027-01-01' }];
    });
    expect(messages(entryIssues(e))).toContain(
      'SCC record: certificationEndDate applies only to a DPF record',
    );
    const dpf = draft((d) => {
      const m = d.legal.transferMechanisms.find((r) => r.mechanism === 'DPF');
      if (m) m.certificationEndDate = '2027-01-01';
    });
    expect(entryIssues(dpf)).toEqual([]);
  });

  it('refuses a DPF record whose dpfCertified disagrees with its observed status', () => {
    const auth0 = structuredClone(read('auth0'));
    const record = auth0.legal.transferMechanisms.find((m) => m.mechanism === 'DPF');
    if (record) {
      record.observedStatus = 'Active - Re-certification under Review';
      record.dpfCertified = true;
    }
    expect(messages(entryIssues(auth0)).some((m) => /reads as qualified/.test(m))).toBe(true);
    // A named acceptance is what makes the same record valid.
    if (record) record.acceptQualifiedStatus = { acceptedBy: 'A Person', reason: 'checked' };
    expect(entryIssues(auth0)).toEqual([]);
  });

  it('refuses an acceptance on a status that is not the qualified one', () => {
    const clerk = structuredClone(read('clerk'));
    const record = clerk.legal.transferMechanisms.find((m) => m.mechanism === 'DPF');
    if (record) record.acceptQualifiedStatus = { acceptedBy: 'A Person', reason: 'x' };
    expect(messages(entryIssues(clerk)).some((m) => /applies only to/.test(m))).toBe(true);
  });

  it('never quotes an entry note in a message', () => {
    const issues = entryIssues(
      draft((e) => {
        e.notes = 'avoid SENTINEL-TEXT';
      }),
    );
    expect(JSON.stringify(issues)).not.toContain('SENTINEL-TEXT');
  });
});

describe('collisionIssues', () => {
  it('passes the shipped set', () => {
    expect(collisionIssues(shipped)).toEqual([]);
  });

  it('passes a clean draft beside the shipped set', () => {
    expect(collisionIssues([...shipped, draft()])).toEqual([]);
  });

  it.each([
    [
      'a shipped id',
      (e: VendorEntry) => {
        e.id = 'stripe';
      },
      /duplicate vendor id/,
    ],
    [
      'a shipped host',
      (e: VendorEntry) => {
        e.aliases.hosts = [{ pattern: 'api.stripe.com', match: 'exact', purpose: 'api' } as never];
      },
      /host pattern "api.stripe.com" already claimed by "stripe"/,
    ],
    [
      'a shipped package',
      (e: VendorEntry) => {
        e.aliases.packages.npm = [{ name: 'stripe', kind: 'official-sdk' } as never];
      },
      /package alias "npm:stripe" already claimed by "stripe"/,
    ],
    [
      'a scope that swallows a shipped package',
      (e: VendorEntry) => {
        e.aliases.packages.npm = [{ name: '@sentry/*', kind: 'scope' } as never];
      },
      /already claimed|swallows/,
    ],
  ])('refuses a draft reusing %s', (_, edit, pattern) => {
    const issues = collisionIssues([...shipped, draft(edit)]);
    expect(messages(issues).some((m) => pattern.test(m))).toBe(true);
  });
});
