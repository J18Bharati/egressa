import { describe, expect, it } from 'vitest';
import { scan } from './scan.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const run = (name: string, extra: Record<string, unknown> = {}) =>
  scan({
    root: `fixtures/repos/${name}`,
    toolVersion: '0.1.0',
    kbPath: 'kb',
    includeCallsites: true,
    now: NOW,
    ...extra,
  });

describe('fixture: nextjs-analytics-heavy', () => {
  const result = run('nextjs-analytics-heavy');

  it('merges manifest and call-site evidence per vendor', () => {
    const openai = result.findings.find((f) => f.vendor?.id === 'openai');
    const kinds = openai?.evidence.map((e) => e.kind).sort();
    expect(kinds).toEqual(['callsite', 'dependency']);
  });

  it('resolves a Sentry ingest subdomain through the suffix trie', () => {
    const sentry = result.findings.find((f) => f.vendor?.id === 'sentry');
    expect(sentry?.evidence.some((e) => e.matchedOn === 'o4507.ingest.sentry.io')).toBe(true);
  });

  it('separates a DPF-certified vendor from one that is not', () => {
    // Same country, different certification status, so different rules.
    expect(result.findings.find((f) => f.vendor?.id === 'sentry')?.ruleId).toBe(
      'transfer/adequate-country-egress',
    );
    expect(result.findings.find((f) => f.vendor?.id === 'openai')?.ruleId).toBe(
      'transfer/third-country-egress-eu-region-available',
    );
  });

  it('detects a beacon call to Google Analytics', () => {
    const ga = result.findings.find((f) => f.vendor?.id === 'google-analytics');
    expect(ga?.evidence.some((e) => e.matchedOn === 'www.google-analytics.com')).toBe(true);
  });
});

describe('fixture: unresolvable-hosts', () => {
  const result = run('unresolvable-hosts');

  it('produces only unresolved notes and never attributes a vendor', () => {
    expect(result.findings.every((f) => f.ruleId === 'transfer/unresolved-egress')).toBe(true);
    expect(result.findings.every((f) => f.vendor === null)).toBe(true);
    expect(result.summary.unresolvedEgress).toBe(result.findings.length);
  });

  it('names the environment variable so a human can go and look', () => {
    expect(JSON.stringify(result.findings)).toContain('ANALYTICS_URL');
  });

  it('keeps every unresolved finding at low confidence', () => {
    expect(result.findings.every((f) => f.confidence === 'low')).toBe(true);
  });
});

describe('fixture: minified-vendored', () => {
  const result = run('minified-vendored');

  it('never opens generated output, even though it contains real vendor URLs', () => {
    expect(result.scan.filesScanned).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

describe('fixture: clean-eu-only', () => {
  it('stays silent: the false-positive guard', () => {
    const result = run('clean-eu-only');
    expect(result.findings).toEqual([]);
    expect(result.summary.bySeverity.warning).toBe(0);
  });
});

describe('determinism and performance guards', () => {
  it('produces byte-identical output across runs', () => {
    const strip = (r: unknown) => JSON.stringify(r, (k, v) => (k === 'durationMs' ? 0 : v));
    expect(strip(run('nextjs-analytics-heavy'))).toBe(strip(run('nextjs-analytics-heavy')));
  });

  it('scans a fixture repository well under the CI budget', () => {
    expect(run('nextjs-analytics-heavy').scan.durationMs).toBeLessThan(10_000);
  });
});
