import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nameFromSpecifier, parseYarnBerryLock, parseYarnClassicLock } from './yarn-lock.js';

const read = (name: string) => readFileSync(`fixtures/lockfiles/${name}`, 'utf8');

describe('nameFromSpecifier', () => {
  it('splits plain specifiers', () => {
    expect(nameFromSpecifier('stripe@^17.4.0')).toBe('stripe');
  });

  it('keeps scopes intact', () => {
    expect(nameFromSpecifier('"@sentry/node@^7.120.0"')).toBe('@sentry/node');
  });

  it('handles berry protocol specifiers', () => {
    expect(nameFromSpecifier('stripe@npm:17.4.0')).toBe('stripe');
    expect(nameFromSpecifier('demo-app@workspace:.')).toBe('demo-app');
  });

  it('returns null for a bare scope with no name', () => {
    expect(nameFromSpecifier('@scope')).toBeNull();
  });
});

describe('parseYarnClassicLock', () => {
  const { dependencies } = parseYarnClassicLock(read('yarn-classic.yarn.lock'), 'yarn.lock');
  const byName = Object.fromEntries(dependencies.map((d) => [d.name, d]));

  it('reads every entry, ignoring the comment header', () => {
    expect(Object.keys(byName).sort()).toEqual(['@sentry/core', '@sentry/node', 'qs', 'stripe']);
  });

  it('collapses multi-specifier headers to one record', () => {
    expect(dependencies.filter((d) => d.name === '@sentry/core')).toHaveLength(1);
  });

  it('reads the version from the entry body', () => {
    expect(byName.stripe?.version).toBe('17.4.0');
    expect(byName['@sentry/node']?.version).toBe('7.120.0');
  });

  it('does not claim to know dev-ness, which v1 does not record', () => {
    expect(dependencies.every((d) => d.dev === false)).toBe(true);
  });

  it('anchors on the header line', () => {
    expect(byName.stripe?.snippet).toBe('stripe@^17.4.0:');
  });
});

describe('parseYarnBerryLock', () => {
  const { dependencies, errors } = parseYarnBerryLock(read('yarn-berry.yarn.lock'), 'yarn.lock');
  const byName = Object.fromEntries(dependencies.map((d) => [d.name, d]));

  it('parses without errors and skips __metadata', () => {
    expect(errors).toEqual([]);
    expect(byName.__metadata).toBeUndefined();
  });

  it('prefers the resolution field when naming a package', () => {
    expect(byName['@sentry/nextjs']?.version).toBe('8.42.0');
    expect(byName.stripe?.version).toBe('17.4.0');
  });

  it('includes workspace entries, which the merge layer filters by name', () => {
    expect(byName['demo-app']).toBeDefined();
  });
});
