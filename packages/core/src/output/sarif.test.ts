import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from '../claims.js';
import { RULE_IDS } from '../rules.js';
import { scan } from '../scan.js';
import type { ScanResult } from '../types.js';
import { toSarif } from './sarif.js';

const sarifSchema = JSON.parse(
  readFileSync('schemas/vendor/sarif-schema-2.1.0.json', 'utf8'),
) as object;
const ajv = new Ajv04({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateSarif = ajv.compile(sarifSchema);

const load = (name: string): ScanResult =>
  JSON.parse(readFileSync(`examples/${name}`, 'utf8')) as ScanResult;

/** The emitter returns `unknown` by design; tests reach into the shape. */
// biome-ignore lint/suspicious/noExplicitAny: navigating an untyped SARIF document
type AnySarif = any;

describe('toSarif', () => {
  const result = load('findings-third-country.json');
  const sarif = toSarif(result, { toolVersion: '0.1.0' }) as AnySarif;

  it('validates against the official SARIF 2.1.0 schema', () => {
    const ok = validateSarif(sarif);
    if (!ok) {
      const messages = (validateSarif.errors ?? [])
        .slice(0, 8)
        .map((e) => `${e.instancePath} ${e.message}`);
      expect(messages).toEqual([]);
    }
    expect(ok).toBe(true);
  });

  it('carries the disclaimer in the tool driver', () => {
    expect(sarif.runs[0].tool.driver.fullDescription.text).toBe(DISCLAIMER);
  });

  it('declares every rule, so alerts render even for rules not hit this run', () => {
    const ids = sarif.runs[0].tool.driver.rules.map((r: AnySarif) => r.id);
    expect(ids.sort()).toEqual([...RULE_IDS].sort());
  });

  it('puts the DPA link, sources and lastVerified in help.markdown for the alert pane', () => {
    const rule = sarif.runs[0].tool.driver.rules.find(
      (r: AnySarif) => r.id === 'transfer/third-country-egress',
    );
    expect(rule.help.markdown).toContain('https://stripe.com/legal/dpa');
    expect(rule.help.markdown).toContain('Last verified: 2026-07-14');
    expect(rule.help.markdown).toContain('Source:');
    expect(rule.help.markdown).toContain(DISCLAIMER);
  });

  it('sets partialFingerprints so alerts survive line shifts', () => {
    expect(sarif.runs[0].results[0].partialFingerprints['egressa/vendorRule/v1']).toBe(
      result.findings[0]?.id,
    );
  });

  it('puts the strongest evidence first and the rest in relatedLocations', () => {
    const first = sarif.runs[0].results[0];
    expect(first.locations).toHaveLength(1);
    expect(first.locations[0].physicalLocation.artifactLocation.uri).toBe('src/pay.ts');
    expect(first.relatedLocations).toHaveLength(1);
    expect(first.relatedLocations[0].physicalLocation.artifactLocation.uri).toBe('package.json');
  });

  it('never emits security-severity: a data transfer is not a vulnerability', () => {
    const serialised = JSON.stringify(sarif);
    expect(serialised).not.toContain('security-severity');
  });

  it('ranks by severity and confidence so GitHub sorts sensibly', () => {
    expect(sarif.runs[0].results[0].rank).toBe(75); // warning(55) + high(20)
  });

  it('records the knowledge base version on the run for auditability', () => {
    expect(sarif.runs[0].properties.kbVersion).toBe('2026.09.01');
  });
});

describe('toSarif: confidence and suppression', () => {
  const result = load('findings-unresolved-and-suppressed.json');
  const sarif = toSarif(result, { toolVersion: '0.1.0' }) as AnySarif;

  it('validates against the official schema', () => {
    expect(validateSarif(sarif)).toBe(true);
  });

  it('prefixes non-high confidence into the message, since SARIF has no such field', () => {
    const posthog = sarif.runs[0].results.find(
      (r: AnySarif) => r.properties.vendorId === 'posthog',
    );
    expect(posthog.message.text).toContain('[medium confidence]');
  });

  it('emits suppressed findings as dismissed rather than dropping them', () => {
    const posthog = sarif.runs[0].results.find(
      (r: AnySarif) => r.properties.vendorId === 'posthog',
    );
    expect(posthog.suppressions).toHaveLength(1);
    expect(posthog.suppressions[0].justification).toContain('PRIV-412');
  });

  it('reports an unresolved host without naming a vendor', () => {
    const unresolved = sarif.runs[0].results.find(
      (r: AnySarif) => r.ruleId === 'transfer/unresolved-egress',
    );
    expect(unresolved.properties.vendorId).toBeNull();
    expect(unresolved.message.text).toContain('Unrecognised destination');
  });

  it('surfaces an assumed-lapsed adequacy run in run properties', () => {
    expect(sarif.runs[0].properties.assumedAdequacyLapsed).toEqual(['US:DPF']);
  });
});

/**
 * SARIF is the surface GitHub Code Scanning renders, and `docs/LIMITATIONS.md`
 * says a consumer that shows a reference the way it shows a call site
 * re-creates the defect the kind exists to prevent. The human and markdown
 * formatters both have a case for this; SARIF did not.
 */
describe('toSarif marks a reference-only finding', () => {
  const NOW = new Date('2026-09-06T12:00:00.000Z');

  const scanOf = (source: string): ScanResult => {
    const dir = mkdtempSync(join(tmpdir(), 'sarif-reference-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'r', version: '1.0.0', private: true }),
    );
    writeFileSync(join(dir, 'src', 'index.ts'), source);
    return scan({
      root: dir,
      toolVersion: '0.1.0',
      kbPath: 'kb',
      includeCallsites: true,
      now: NOW,
    });
  };

  const messages = (result: ScanResult): string[] =>
    ((toSarif(result, { toolVersion: '0.1.0' }) as AnySarif).runs[0].results as AnySarif[]).map(
      (r) => r.message.text as string,
    );

  it('says so when nothing observed a call', () => {
    const texts = messages(scanOf("const u = new URL('https://api.stripe.com/v1');\n"));
    expect(texts.some((t) => t.includes('Named, not called.'))).toBe(true);
  });

  it('and stays silent when a call site is present', () => {
    const texts = messages(scanOf("await fetch('https://api.stripe.com/v1/charges');\n"));
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((t) => t.includes('Named, not called.'))).toBe(false);
  });
});

describe('toSarif: errors from the scan', () => {
  // Field test 4 review. Every other surface shows a config warning or a
  // parse error; SARIF, the one GitHub reads, dropped them all.
  const base = load('findings-third-country.json');
  const withErrors: ScanResult = {
    ...base,
    errors: [
      {
        file: '.egressa.yml',
        message: 'suppression 1 (vendor Stripe) matched no finding',
        fatal: false,
      },
      { file: '/abs/root', message: 'not a readable directory; nothing was scanned', fatal: true },
    ],
  };
  const sarif = toSarif(withErrors, { toolVersion: '0.1.0' }) as AnySarif;

  it('validates against the official schema', () => {
    expect(validateSarif(sarif)).toBe(true);
  });

  it('reports each error as a tool execution notification at its level', () => {
    const [invocation] = sarif.runs[0].invocations;
    expect(invocation.executionSuccessful).toBe(false);
    expect(
      invocation.toolExecutionNotifications.map((n: AnySarif) => [n.level, n.message.text]),
    ).toEqual([
      ['warning', 'suppression 1 (vendor Stripe) matched no finding'],
      ['error', 'not a readable directory; nothing was scanned'],
    ]);
    // A repository-relative file is located; an absolute one is not.
    expect(
      invocation.toolExecutionNotifications[0].locations[0].physicalLocation.artifactLocation.uri,
    ).toBe('.egressa.yml');
    expect(invocation.toolExecutionNotifications[1].locations).toBeUndefined();
  });

  it('adds no invocation when the scan had no errors', () => {
    const clean = toSarif({ ...base, errors: [] }, { toolVersion: '0.1.0' }) as AnySarif;
    expect(clean.runs[0].invocations).toBeUndefined();
  });
});
