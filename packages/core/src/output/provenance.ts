import { RULES } from '../rules.js';
import type { FactsSummary, Finding, RepositoryFactRef, Severity } from '../types.js';

/**
 * Provenance wording shared by every surface that renders a scan.
 *
 * A repository's `.egressa/facts.json` can change what a finding says, and a
 * reader of SARIF, markdown or the terminal has to be able to see that without
 * opening the JSON. The sentences live here, once, so the surfaces cannot drift
 * apart: `scripts/provenance-contract.test.ts` checks each of them carries
 * `FACTS_MARKER`.
 *
 * Every string a repository supplied (`verifiedBy`, `observedStatus`, a file
 * path) is passed through `render`, which the caller picks for its medium.
 */

/** The phrase every surface carries when a scan read a facts file. */
export const FACTS_MARKER = 'repository-supplied facts';

const LEVEL: Record<Severity, number> = { note: 1, warning: 2, error: 3 };

/**
 * How repository facts moved this finding's rule, or null when they did not.
 *
 * One definition for every surface and for the run's counts. A move to a less
 * severe rule loosens. So does a move between rules of the same level when an
 * applied fact on the finding was judged to loosen by the trust gate: a local
 * entry turns `transfer/unknown-vendor-egress` into `transfer/eu-processing`,
 * both notes, and that is exactly the change `--trust-facts` exists to gate.
 * A move to a more severe rule tightens, whatever the fact's label: a fact can
 * loosen in general and still leave this finding stricter.
 */
export function factsDirection(finding: Finding): 'loosened' | 'tightened' | 'changed' | null {
  if (!finding.baselineRuleId) return null;
  const now = LEVEL[RULES[finding.ruleId].defaultLevel];
  const before = LEVEL[RULES[finding.baselineRuleId].defaultLevel];
  if (now < before) return 'loosened';
  if (now > before) return 'tightened';
  const gated = finding.transfer?.repositoryFacts?.some((r) => r.effect === 'loosens') ?? false;
  return gated ? 'loosened' : 'changed';
}

/** True when repository facts moved this finding to a less severe rule. */
export function loosenedByFacts(finding: Finding): boolean {
  return factsDirection(finding) === 'loosened';
}

/** True when the vendor entry itself came from the scanned repository. */
export function isLocalVendor(finding: Finding): boolean {
  return finding.vendor?.origin === 'local';
}

/** The run-level sentence: how many findings rest on the file, and how many it loosened. */
export function factsHeadline(facts: FactsSummary, render: (s: string) => string): string {
  const n = facts.findingsDependingOnFacts;
  const parts = [
    `${n} finding${n === 1 ? '' : 's'} depend${n === 1 ? 's' : ''} on ${FACTS_MARKER} ` +
      `(${render(facts.source)}), ${facts.loosened} loosened`,
  ];
  if (facts.notTrusted > 0) {
    parts.push(
      `${facts.notTrusted} loosening fact${facts.notTrusted === 1 ? '' : 's'} not applied (the caller did not trust this repository)`,
    );
  }
  if (facts.expired > 0) parts.push(`${facts.expired} expired`);
  if (facts.rejected > 0) parts.push(`${facts.rejected} rejected`);
  if (facts.localVendors > 0) {
    parts.push(
      `${facts.localVendors} vendor entr${facts.localVendors === 1 ? 'y' : 'ies'} supplied by the repository`,
    );
  }
  return `${parts.join('; ')}.`;
}

/**
 * One fact as a line a reader can check by hand: what it is, where it sits in
 * the file, what it says, the page it cites, and who read that page when.
 */
export function factRefText(ref: RepositoryFactRef, render: (s: string) => string): string {
  const status = ref.observedStatus ? ` status "${render(ref.observedStatus)}"` : '';
  const supplied = ref.suppliedUrl ? ` supplying ${render(ref.suppliedUrl)}` : '';
  const source = ref.sourceUrl ? `, source ${render(ref.sourceUrl)}` : '';
  return (
    `${ref.fact}${status}${supplied} (${ref.effect}) from ${render(ref.file)} ${render(ref.at)}` +
    `, retrieved ${ref.retrievedAt} by ${render(ref.verifiedBy)}, expires ${ref.expiresOn}${source}`
  );
}

/** The per-finding note: the rule before facts were applied, when they changed it. */
export function baselineText(finding: Finding): string | null {
  const how = factsDirection(finding);
  if (!how) return null;
  return `${how} by ${FACTS_MARKER}; without them this finding is ${finding.baselineRuleId}`;
}
