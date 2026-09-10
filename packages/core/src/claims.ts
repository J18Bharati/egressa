/**
 * The single source of truth for what Egressa claims about itself.
 *
 * Every user-visible surface -- human output, JSON, SARIF, MCP tool descriptions,
 * the skill, and the README -- imports the disclaimer from here. `claims.test.ts`
 * asserts it reaches all of them, and that no output string contains a word from
 * FORBIDDEN_CLAIM_WORDS.
 *
 * This is enforced in code rather than documented in a style guide on purpose:
 * the failure mode for tooling in this category is language drift, where a
 * findings summary written months apart from the policy quietly starts implying
 * that a clean scan means compliance. A test cannot drift.
 */

/**
 * The sentence that refuses the conclusion, shared by every surface that reports a
 * legal exposure of any kind.
 *
 * It exists so that a surface whose *scope* is not cross-border transfers -- the
 * review skills, which also look at consent, retention and logging -- can carry
 * the identical refusal without quoting a scope sentence that would misdescribe
 * it. One refusal, one source.
 *
 * It is a separate literal rather than interpolated into DISCLAIMER, so that both
 * read as plain sentences at the point of definition. `claims.test.ts` asserts
 * DISCLAIMER still ends with it, which is what keeps them from drifting apart --
 * the same trade this file makes everywhere: a test instead of a convention.
 */
export const NON_ASSESSMENT = 'It does not assess or certify GDPR compliance.';

/** The claim, used verbatim everywhere. Never reword per-surface. */
export const DISCLAIMER =
  'Egressa detects third-party data-egress patterns in source code and their ' +
  'cross-border transfer exposure. It does not assess or certify GDPR compliance.';

/** Short form for space-constrained surfaces (CLI footer, SARIF result messages). */
export const DISCLAIMER_SHORT = 'Detection only - not a compliance assessment.';

/**
 * Stems that must never appear in generated output.
 *
 * Each entry is a claim Egressa is not entitled to make from static analysis:
 * it observes that code references a vendor, not that any personal data was
 * actually sent, nor that sending it was unlawful.
 *
 * These are stems, not exact words. The matcher appends INFLECTIONS, so
 * "violation" also catches "violations" and "illegal" also catches "illegally".
 * Listing exact words instead left the obvious plurals through -- "GDPR
 * violations: 3" passed every surface check in the repository -- which is the
 * failure mode a vocabulary list is supposed to prevent.
 *
 * "compliance" on its own is deliberately absent: it is legitimate in the
 * disclaimer and in prose describing what the tool does not do.
 */
export const FORBIDDEN_CLAIM_WORDS: readonly string[] = [
  'compliant',
  'non-compliant',
  'fully compliant',
  'compliance certified',
  'certified compliant',
  'violate',
  'violation',
  'illegal',
  'unlawful',
  'guarantee',
  'audit-ready',
];

/**
 * Suffixes appended to every stem when matching.
 *
 * Deliberately small. A stemmer would catch more and misfire more; this covers
 * the inflections that actually appear in claim-shaped prose.
 */
const INFLECTIONS = '(?:s|es|d|ed|ing|ly|ions?)?';

/**
 * Strings permitted to contain otherwise-forbidden words, because they are the
 * disclaimer or a direct quotation of law. Checked by exact substring match
 * before the forbidden-word scan runs.
 */
export const DISCLAIMER_ALLOWLIST: readonly string[] = [DISCLAIMER, DISCLAIMER_SHORT];

/**
 * Scan a user-visible string for forbidden claims.
 * Returns the words found, or an empty array when the string is clean.
 */
export function findForbiddenClaims(text: string): string[] {
  let haystack = text;
  for (const allowed of DISCLAIMER_ALLOWLIST) {
    haystack = haystack.split(allowed).join(' ');
  }
  // URLs are removed before matching. A citation's address is the publisher's
  // wording, not a claim Egressa makes -- the Austrian DSB decision is filed by
  // noyb under a slug ending "-illegal", and a knowledge base that is required
  // to cite its sources must be able to link to it. Prose around the link is
  // still scanned.
  haystack = haystack.replace(/https?:\/\/\S+/gi, ' ');
  const lower = haystack.toLowerCase();
  // The boundary class excludes only letters and digits, so a hyphenated
  // compound such as "gdpr-violation-report" is caught rather than hidden by
  // its own punctuation. A stem inside a longer forbidden phrase matches too,
  // and both are reported; callers only ask whether the list is empty.
  return FORBIDDEN_CLAIM_WORDS.filter((word) => {
    const pattern = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(word)}${INFLECTIONS}([^a-z0-9]|$)`,
      'i',
    );
    return pattern.test(lower);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
