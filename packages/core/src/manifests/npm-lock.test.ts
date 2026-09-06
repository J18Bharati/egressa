import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNpmLock } from './npm-lock.js';

const read = (name: string) => readFileSync(`fixtures/lockfiles/${name}`, 'utf8');

describe('parseNpmLock: lockfileVersion 3 (packages map)', () => {
  const { dependencies, errors } = parseNpmLock(
    read('npm-v3.package-lock.json'),
    'package-lock.json',
  );
  const byName = Object.fromEntries(dependencies.map((d) => [d.name, d]));

  it('parses without errors', () => {
    expect(errors).toEqual([]);
  });

  it('skips the root ("") entry, which is the project itself', () => {
    expect(dependencies.find((d) => d.name === 'demo-app')).toBeUndefined();
  });

  it('recovers names and versions from node_modules keys', () => {
    expect(byName.stripe?.version).toBe('17.4.0');
    expect(byName.qs?.version).toBe('6.13.0');
  });

  it('carries the dev flag through', () => {
    expect(byName.vitest?.dev).toBe(true);
    expect(byName.stripe?.dev).toBe(false);
  });

  it('records the nesting chain for nested installs', () => {
    expect(byName.chai?.transitiveVia).toEqual(['vitest']);
    expect(byName.stripe?.transitiveVia).toBeUndefined();
  });

  it('marks everything as indirect: only package.json knows what is declared', () => {
    expect(dependencies.every((d) => d.direct === false)).toBe(true);
  });

  it('anchors each entry at its own line', () => {
    expect(byName.stripe?.loc.startLine).toBe(13);
  });
});

describe('parseNpmLock: lockfileVersion 1 (nested tree)', () => {
  const { dependencies } = parseNpmLock(read('npm-v1.package-lock.json'), 'package-lock.json');
  const byName = Object.fromEntries(dependencies.map((d) => [d.name, d]));

  it('walks the nested dependencies tree', () => {
    expect(Object.keys(byName).sort()).toEqual(['@sentry/core', '@sentry/node', 'eslint']);
  });

  it('records the dependent chain for nested entries', () => {
    expect(byName['@sentry/core']?.transitiveVia).toEqual(['@sentry/node']);
  });

  it('carries the dev flag', () => {
    expect(byName.eslint?.dev).toBe(true);
  });
});

describe('parseNpmLock: malformed input', () => {
  it('reports rather than throws', () => {
    const result = parseNpmLock('not json at all', 'package-lock.json');
    expect(result.dependencies).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
