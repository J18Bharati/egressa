import { describe, expect, it } from 'vitest';
import { FAIL_ON_LEVELS, isFailOnLevel } from './config/index.js';
import { RULE_IDS, getRule, isRuleId } from './rules.js';

describe('isRuleId', () => {
  it('accepts every rule id', () => {
    for (const id of RULE_IDS) expect(isRuleId(id)).toBe(true);
  });

  it('refuses keys every object inherits', () => {
    // RULES is an object literal: indexing it with these returns a function,
    // which a truthiness check then reads as a rule.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isRuleId(key)).toBe(false);
    }
  });

  it('makes getRule refuse them too', () => {
    expect(() => getRule('constructor' as never)).toThrow(/Unknown rule id/);
  });
});

describe('isFailOnLevel', () => {
  it('accepts every level and nothing else', () => {
    for (const level of FAIL_ON_LEVELS) expect(isFailOnLevel(level)).toBe(true);
    for (const value of ['', 'warn', 'constructor', 1, null, undefined]) {
      expect(isFailOnLevel(value)).toBe(false);
    }
  });
});
