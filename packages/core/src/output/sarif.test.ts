import { readFileSync } from 'node:fs';
import Ajv04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from '../claims.js';
import { RULE_IDS } from '../rules.js';
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
    expect(sarif.runs[0].results[0].partialFingerprints['adequacy/vendorRule/v1']).toBe(
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
