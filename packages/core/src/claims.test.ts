import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  DISCLAIMER_SHORT,
  FORBIDDEN_CLAIM_WORDS,
  NON_ASSESSMENT,
  findForbiddenClaims,
} from './claims.js';
import { RULES, RULE_IDS } from './rules.js';

describe('the refusal sentence', () => {
  it('is the tail of the full disclaimer, so both surfaces refuse identically', () => {
    // A surface whose scope is not cross-border transfers carries NON_ASSESSMENT
    // alone. If someone reworded either literal, the two claims would quietly
    // diverge and the review skills would stop refusing what the scanner refuses.
    expect(DISCLAIMER.endsWith(NON_ASSESSMENT)).toBe(true);
  });
});

describe('claims contract', () => {
  it('the disclaimer itself passes the forbidden-word scan', () => {
    // It contains "certify" and "compliance"; the allowlist must exempt it.
    expect(findForbiddenClaims(DISCLAIMER)).toEqual([]);
    expect(findForbiddenClaims(DISCLAIMER_SHORT)).toEqual([]);
  });

  it('flags claims that leap from "references a vendor" to "broke the law"', () => {
    expect(findForbiddenClaims('This is a violation of GDPR.')).toContain('violation');
    expect(findForbiddenClaims('Your project is fully compliant.')).toContain('compliant');
    expect(findForbiddenClaims('This guarantees lawful processing.')).toContain('guarantee');
  });

  it('does not flag ordinary finding prose', () => {
    const prose =
      'Sends data to Stripe, Inc. (US, IE). An EU region is not documented for this product. ' +
      'Check the DPA and sub-processor list before relying on this integration.';
    expect(findForbiddenClaims(prose)).toEqual([]);
  });

  it('matches on word boundaries, not substrings', () => {
    // A stem must not fire when it is buried inside a longer word.
    expect(findForbiddenClaims('an inviolate boundary')).toEqual([]);
    expect(findForbiddenClaims('a compliance assessment')).toEqual([]);
    // ...but a hyphen is punctuation, not part of a word, so it cannot hide one.
    expect(findForbiddenClaims('gdpr-violation-report')).toContain('violation');
    // A citation URL carries the publisher's wording, not ours.
    expect(findForbiddenClaims('see https://noyb.eu/en/google-analytics-illegal')).toEqual([]);
  });

  it('every forbidden word is actually detected', () => {
    for (const word of FORBIDDEN_CLAIM_WORDS) {
      expect(findForbiddenClaims(`prefix ${word} suffix`).length).toBeGreaterThan(0);
    }
  });
});

describe('rule table', () => {
  it('exposes every rule id declared in the type union', () => {
    expect(RULE_IDS).toHaveLength(8);
    for (const id of RULE_IDS) expect(RULES[id].id).toBe(id);
  });

  it('defaults nothing to error: we detect, we do not adjudicate', () => {
    for (const id of RULE_IDS) expect(RULES[id].defaultLevel).not.toBe('error');
  });

  it('keeps rule descriptions and help text free of forbidden claims', () => {
    for (const id of RULE_IDS) {
      const rule = RULES[id];
      const text = [rule.shortDescription, rule.fullDescription, rule.help].join(' ');
      expect({ id, forbidden: findForbiddenClaims(text) }).toEqual({ id, forbidden: [] });
    }
  });

  it('gives every rule a SARIF name distinct from its id', () => {
    const names = RULE_IDS.map((id) => RULES[id].name);
    expect(new Set(names).size).toBe(names.length);
  });
});
