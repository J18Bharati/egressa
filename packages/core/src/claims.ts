/**
 * The single source of truth for what Adequacy claims about itself.
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

/** The claim, used verbatim everywhere. Never reword per-surface. */
export const DISCLAIMER =
  'Adequacy detects third-party data-egress patterns in source code and their ' +
  'cross-border transfer exposure. It does not assess or certify GDPR compliance.';

/** Short form for space-constrained surfaces (CLI footer, SARIF result messages). */
export const DISCLAIMER_SHORT = 'Detection only - not a compliance assessment.';

/**
 * Words that must never appear in generated output.
 *
 * Each entry is a claim Adequacy is not entitled to make from static analysis:
 * it observes that code references a vendor, not that any personal data was
 * actually sent, nor that sending it was unlawful. Matching is case-insensitive
 * and word-boundary anchored, so "compliance" as part of the disclaimer itself
 * is excluded by DISCLAIMER_ALLOWLIST rather than by loose matching.
 */
export const FORBIDDEN_CLAIM_WORDS: readonly string[] = [
  'compliant',
  'non-compliant',
  'compliance certified',
  'certified compliant',
  'violation',
  'violates',
  'illegal',
  'unlawful',
  'guarantees',
  'guaranteed',
  'audit-ready',
  'fully compliant',
];

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
  const lower = haystack.toLowerCase();
  return FORBIDDEN_CLAIM_WORDS.filter((word) => {
    const pattern = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(word)}([^a-z0-9-]|$)`, 'i');
    return pattern.test(lower);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
