import { readFileSync, readdirSync } from 'node:fs';
import { loadKnowledgeBase } from '@egressa/kb';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { scan } from '../scan.js';
import { FINDINGS_SCHEMA_VERSION, type Finding, type ScanResult } from '../types.js';
import { checkFacts, loadFacts, parseFacts } from './load.js';
import { applyOverlay } from './overlay.js';

const ROOT = 'fixtures/repos/overlay-dpf';
const NOW = new Date('2026-11-10T12:00:00Z');
const kb = loadKnowledgeBase({ kbPath: 'kb' });
const fixtureText = readFileSync(`${ROOT}/.egressa/facts.json`, 'utf8');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(
  JSON.parse(readFileSync(`schemas/findings-${FINDINGS_SCHEMA_VERSION}.json`, 'utf8')) as object,
);

type Options = { trustFacts?: boolean; now?: Date; text?: string; lapsed?: string[] };
function run({ trustFacts = false, now = NOW, text, lapsed }: Options = {}): ScanResult {
  return scan({
    root: ROOT,
    toolVersion: '0.1.0',
    kbPath: 'kb',
    now,
    includeCallsites: true,
    facts: text === undefined ? loadFacts(ROOT) : parseFacts(text, '.egressa/facts.json'),
    trustFacts,
    ...(lapsed ? { assumeAdequacyLapsed: lapsed } : {}),
  });
}
const vendorFinding = (result: ScanResult, id: string): Finding => {
  const found = result.findings.find(
    (f) => f.vendor?.id === id && f.ruleId.startsWith('transfer/'),
  );
  if (!found) throw new Error(`no finding for ${id}`);
  return found;
};
/** A fact as JSON. A field set to undefined is dropped when it is written back. */
type FactJson = {
  source: Record<string, unknown>;
  value: Record<string, unknown>;
  verifiedBy?: unknown;
};
/** The fixture with one fact edited. */
function edited(index: number, edit: (fact: FactJson) => void): string {
  const doc = JSON.parse(fixtureText);
  edit(doc.facts[index]);
  return JSON.stringify(doc);
}

describe('no facts file: output unchanged', () => {
  it('adds no field to any fixture scan when there is no facts file', () => {
    for (const name of readdirSync('fixtures/repos')) {
      const root = `fixtures/repos/${name}`;
      const base = { root, toolVersion: '0.1.0', kbPath: 'kb', now: NOW, includeCallsites: true };
      const without = scan(base);
      const withNull = scan({ ...base, facts: null, trustFacts: true });
      const strip = (r: ScanResult) => ({ ...r, scan: { ...r.scan, durationMs: 0 } });
      expect(strip(withNull)).toEqual(strip(without));
      const text = JSON.stringify(without);
      for (const field of ['repositoryFacts', 'baselineRuleId', '"origin"', 'factSource:']) {
        expect(text, `${name}: ${field}`).not.toContain(field);
      }
      expect(without.facts).toBeUndefined();
    }
  });
});

describe('applying facts', () => {
  const untrusted = run();
  const trusted = run({ trustFacts: true });

  it('validates against the published schema, trusted or not', () => {
    for (const result of [untrusted, trusted]) {
      const ok = validate(result);
      if (!ok) expect(validate.errors?.slice(0, 5)).toEqual([]);
      expect(ok).toBe(true);
    }
  });

  it('applies a tightening fact without trust, and links the new rule to the old one', () => {
    const stripe = vendorFinding(untrusted, 'stripe');
    expect(stripe.ruleId).toBe('transfer/third-country-egress');
    expect(stripe.baselineRuleId).toBe('transfer/adequate-country-egress');
    expect(stripe.transfer?.repositoryFacts).toEqual([
      expect.objectContaining({
        at: 'facts[1]',
        effect: 'tightens',
        observedStatus: 'Inactive - Lapse',
      }),
    ]);
    expect(stripe.exposure?.inputs).toContain('factSource:dpf:overlay');
  });

  it('changes the finding id when a fact changes the rule', () => {
    const plain = scan({
      root: ROOT,
      toolVersion: '0.1.0',
      kbPath: 'kb',
      now: NOW,
      includeCallsites: true,
    });
    expect(vendorFinding(untrusted, 'stripe').id).not.toBe(vendorFinding(plain, 'stripe').id);
    expect(vendorFinding(untrusted, 'openai').id).toBe(vendorFinding(plain, 'openai').id);
  });

  it('refuses a loosening fact without trust: the shipped answer stands, and the count says so', () => {
    const notion = vendorFinding(untrusted, 'notion');
    expect(notion.ruleId).toBe('transfer/third-country-egress-eu-region-available');
    expect(notion.baselineRuleId).toBeUndefined();
    expect(notion.transfer?.repositoryFacts).toBeUndefined();
    expect(untrusted.facts).toMatchObject({ trusted: false, notTrusted: 1, loosened: 0 });
  });

  it('applies the loosening fact with trust, and says it loosened', () => {
    const notion = vendorFinding(trusted, 'notion');
    expect(notion.ruleId).toBe('transfer/adequate-country-egress');
    expect(notion.baselineRuleId).toBe('transfer/third-country-egress-eu-region-available');
    expect(trusted.facts).toMatchObject({ trusted: true, notTrusted: 0, loosened: 1 });
  });

  it('lets an assumed adequacy lapse override a trusted fact', () => {
    const notion = vendorFinding(run({ trustFacts: true, lapsed: ['US:DPF'] }), 'notion');
    expect(notion.ruleId).not.toBe('transfer/adequate-country-egress');
  });

  it('reports a local vendor at medium at most, marked local, never self-certified', () => {
    const local = vendorFinding(untrusted, 'acme-geo');
    expect(local.vendor?.origin).toBe('local');
    expect(local.confidence).not.toBe('high');
    expect(local.exposure?.inputs).toContain('factSource:local');
    const doc = JSON.parse(fixtureText);
    doc.localVendors[0].entry.legal.transferMechanisms.push({
      mechanism: 'DPF',
      dpfCertified: true,
      url: 'https://www.dataprivacyframework.gov/participant/1',
    });
    const claimed = vendorFinding(run({ text: JSON.stringify(doc) }), 'acme-geo');
    expect(claimed.exposure?.inputs).toContain('dpfCertified:false');
  });

  it('records a neutral fact and drops the task it answers', () => {
    const openai = vendorFinding(untrusted, 'openai');
    expect(openai.transfer?.repositoryFacts?.[0]?.effect).toBe('neutral');
    expect(openai.verification?.some((t) => t.reason === 'dpf-unknown') ?? false).toBe(false);
  });

  it('never changes the shipped knowledge base it was given', () => {
    const before = JSON.stringify(kb.byId.get('notion'));
    applyOverlay(kb, checkFacts(parseFacts(fixtureText, 'f'), kb, NOW), { trustFacts: true });
    expect(JSON.stringify(kb.byId.get('notion'))).toBe(before);
  });

  it('calls a fact that repeats the knowledge base redundant', () => {
    const doc = {
      version: 1,
      facts: [
        {
          vendor: 'clerk',
          fact: 'dpf',
          value: {
            observedStatus: 'Active',
            organizationName: 'Clerk, Inc.',
            participantUrl: kb.byId
              .get('clerk')
              ?.legal.transferMechanisms.find((m) => m.mechanism === 'DPF')?.url,
          },
          source: {
            url: 'https://www.dataprivacyframework.gov/list',
            retrievedAt: '2026-11-03',
          },
          verifiedBy: 'A Person',
        },
      ],
    };
    const overlay = applyOverlay(kb, checkFacts(parseFacts(JSON.stringify(doc), 'f'), kb, NOW), {
      trustFacts: true,
    });
    expect(overlay.items.map((i) => i.state)).toEqual(['redundant']);
    expect(overlay.kb).toBe(kb);
  });
});

describe('the gate on each part of a loosening fact', () => {
  // With trust on, so that only the fact's own form stands between it and a
  // loosened finding. Each corruption must leave Notion at its shipped rule.
  const baseline = 'transfer/third-country-egress-eu-region-available';
  it.each([
    [
      'no source URL',
      (f: FactJson) => {
        f.source.url = undefined;
      },
    ],
    [
      'an http source',
      (f: FactJson) => {
        f.source.url = 'http://www.dataprivacyframework.gov/participant/6134';
      },
    ],
    [
      'a source off the DPF site',
      (f: FactJson) => {
        f.source.url = 'https://www.notion.so/dpf';
      },
    ],
    [
      'no retrieval date',
      (f: FactJson) => {
        f.source.retrievedAt = undefined;
      },
    ],
    [
      'a future retrieval date',
      (f: FactJson) => {
        f.source.retrievedAt = '2026-11-20';
      },
    ],
    [
      'no observed status',
      (f: FactJson) => {
        f.value.observedStatus = undefined;
      },
    ],
    [
      'an unrecognised status',
      (f: FactJson) => {
        f.value.observedStatus = 'Active (renewed)';
      },
    ],
    [
      'no participant URL',
      (f: FactJson) => {
        f.value.participantUrl = undefined;
      },
    ],
    [
      'a participant URL off the DPF site',
      (f: FactJson) => {
        f.value.participantUrl = 'https://dataprivacyframework.gov.example.com/participant/6134';
      },
    ],
    [
      'no verifiedBy',
      (f: FactJson) => {
        f.verifiedBy = undefined;
      },
    ],
  ])('%s', (_, edit) => {
    const result = run({ trustFacts: true, text: edited(0, edit) });
    expect(vendorFinding(result, 'notion').ruleId).toBe(baseline);
  });

  it('the unedited fact does loosen, so each case above is the gate working', () => {
    expect(vendorFinding(run({ trustFacts: true }), 'notion').ruleId).not.toBe(baseline);
  });
});

describe('expiry and the clock', () => {
  it('reverts to the shipped answer the day a fact expires, and asks for it to be read again', () => {
    const lastDay = run({ now: new Date('2026-12-02T23:59:59Z') });
    expect(vendorFinding(lastDay, 'stripe').ruleId).toBe('transfer/third-country-egress');
    const after = run({ now: new Date('2026-12-03T00:00:00Z') });
    const stripe = vendorFinding(after, 'stripe');
    expect(stripe.ruleId).toBe('transfer/adequate-country-egress');
    expect(stripe.baselineRuleId).toBeUndefined();
    expect(stripe.verification).toContainEqual(
      expect.objectContaining({ reason: 'overlay-expired', fact: 'dpf' }),
    );
    expect(after.facts?.expired).toBeGreaterThanOrEqual(1);
  });

  it('gives the same output on two dates inside the same window', () => {
    const strip = (r: ScanResult) =>
      JSON.stringify({ findings: r.findings, facts: r.facts, summary: r.summary });
    expect(strip(run({ now: new Date('2026-11-05') }))).toBe(
      strip(run({ now: new Date('2026-11-25') })),
    );
  });
});
