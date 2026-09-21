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

describe('fixture: modern-solo-stack', () => {
  const result = run('modern-solo-stack');
  const find = (id: string) => result.findings.find((f) => f.vendor?.id === id);

  it('reads a configured region out of a vendor SDK initialiser', () => {
    // posthog.init(KEY, { api_host: 'https://eu.i.posthog.com' }). Without the
    // knowledge base client constructors this is a dependency signal only, and
    // which PostHog cloud the project uses is invisible.
    expect(find('posthog')?.evidence.some((e) => e.matchedOn === 'eu.i.posthog.com')).toBe(true);
  });

  it('matches a project subdomain through the suffix trie', () => {
    expect(find('supabase')?.evidence.some((e) => e.matchedOn === 'abcdefghij.supabase.co')).toBe(
      true,
    );
  });

  it('spreads one repository across more than one exposure rule', () => {
    // A stack that all landed on one rule would not exercise the rule table.
    const rules = new Set(result.findings.map((f) => f.ruleId));
    expect(rules.size).toBeGreaterThan(2);
  });

  it('reports a vendor outside the adequacy list as a third-country transfer', () => {
    // Supabase Pte. Ltd is Singapore, which has no adequacy decision.
    expect(find('supabase')?.exposure?.thirdCountryTransfer).toBe(true);
    expect(find('supabase')?.exposure?.additionalSafeguardsRequired).toBe(true);
  });

  it('leaves a customer-domain vendor host unattributed rather than guessing', () => {
    // Clerk's frontend API is served from the customer's own domain, so no host
    // pattern can match it. The package alias still identifies the vendor.
    expect(result.unmatched.hosts).toContain('clerk.example.com');
    expect(find('clerk')).toBeDefined();
  });
});

describe('fixture: regional-multi', () => {
  const result = run('regional-multi');
  const withRegion = (code: string) =>
    result.findings.find((f) => f.evidence.some((e) => e.region === code));

  it('reads a region from Terraform and from a Serverless config', () => {
    // Different languages, same shape: a known key, an equals sign and a
    // quoted literal. main.tf's eu-west-2 merges with the SDK's because they
    // are the same region; serverless.yml's us-west-2 merges with us-east-1
    // because they are different regions with the same legal answer.
    const evidence = result.findings.flatMap((f) => f.evidence);
    expect(evidence.some((e) => e.file === 'main.tf' && e.region === 'eu-west-2')).toBe(true);
    expect(evidence.some((e) => e.file === 'serverless.yml' && e.region === 'us-west-2')).toBe(
      true,
    );
  });

  it('refuses a Terraform region that comes from a variable', () => {
    // main.tf declares gcp with `region = var.deployment_region`. A region
    // resolved at plan time is not a fact about this repository.
    expect(result.findings.some((f) => f.vendor?.id === 'gcp')).toBe(false);
    expect(
      result.findings.flatMap((f) => f.evidence).some((e) => e.region?.startsWith('var')),
    ).toBe(false);
  });

  it('reports one provider in several regions as separate findings', () => {
    // Region is in the grouping key, so "AWS in Ireland" and "AWS in Virginia"
    // do not collapse into one finding whose flags came from whichever signal
    // was seen first.
    const aws = result.findings.filter((f) => f.vendor?.id === 'aws');
    expect(aws.length).toBe(5); // four distinct countries plus the dependency-only signal
    expect(new Set(aws.map((f) => f.id)).size).toBe(5);
  });

  it('does not read London as an EEA region', () => {
    // The whole reason the map is sourced data. Both identifiers begin `eu-`.
    expect(withRegion('eu-west-2')?.exposure?.inputs).toContain('regionCountry:GB');
    expect(withRegion('eu-west-1')?.exposure?.inputs).toContain('regionCountry:IE');
  });

  it('keeps the contracting entity a region does not select', () => {
    // Luxembourg is the EMEA contracting entity and survives narrowing to
    // Ireland; dropping it would report a clean scan on a live contract.
    const narrowed = withRegion('eu-west-1')?.exposure?.inputs.find((i) =>
      i.startsWith('narrowedTo:'),
    );
    expect(narrowed).toContain('LU');
    expect(narrowed).toContain('IE');
  });

  it('never guesses a region supplied at deploy time', () => {
    // src/storage.ts passes process.env.AWS_REGION. No finding may claim it.
    const regions = result.findings.flatMap((f) => f.evidence.map((e) => e.region).filter(Boolean));
    expect([...new Set(regions)].sort()).toEqual([
      'eu-central-1',
      'eu-west-1',
      'eu-west-2',
      'us-east-1',
      'us-west-2',
    ]);
  });

  it('flips every region to a warning when the framework lapses', () => {
    const lapsed = run('regional-multi', { assumeAdequacyLapsed: ['US:DPF'] });
    expect(lapsed.findings.every((f) => f.severity === 'warning')).toBe(true);
  });
});
