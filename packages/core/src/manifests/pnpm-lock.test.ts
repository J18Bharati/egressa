import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePackageKey, parsePnpmLock } from './pnpm-lock.js';

const read = (name: string) => readFileSync(`fixtures/lockfiles/${name}`, 'utf8');

describe('parsePackageKey', () => {
  it('handles v9 bare keys', () => {
    expect(parsePackageKey('stripe@17.4.0')).toEqual({ name: 'stripe', version: '17.4.0' });
  });

  it('handles v6 leading-slash keys', () => {
    expect(parsePackageKey('/stripe@17.4.0')).toEqual({ name: 'stripe', version: '17.4.0' });
  });

  it('keeps the scope when splitting scoped names', () => {
    expect(parsePackageKey('@sentry/core@8.42.0')).toEqual({
      name: '@sentry/core',
      version: '8.42.0',
    });
    expect(parsePackageKey('/@sentry/nextjs@8.42.0')).toEqual({
      name: '@sentry/nextjs',
      version: '8.42.0',
    });
  });

  it('drops the peer-dependency suffix', () => {
    expect(parsePackageKey('/vitest@2.1.8(happy-dom@15.11.6)')).toEqual({
      name: 'vitest',
      version: '2.1.8',
    });
  });

  it('rejects keys with no version', () => {
    expect(parsePackageKey('stripe')).toBeNull();
    expect(parsePackageKey('@scope/name')).toBeNull();
  });
});

describe('parsePnpmLock: v9', () => {
  const { dependencies, errors } = parsePnpmLock(read('pnpm-v9.pnpm-lock.yaml'), 'pnpm-lock.yaml');
  const byName = Object.fromEntries(dependencies.map((d) => [d.name, d]));

  it('parses without errors', () => {
    expect(errors).toEqual([]);
  });

  it('reads every resolved package', () => {
    expect(Object.keys(byName).sort()).toEqual([
      '@sentry/core',
      'posthog-js',
      'qs',
      'stripe',
      'vitest',
    ]);
  });

  it('marks packages listed in importers as direct', () => {
    expect(byName.stripe?.direct).toBe(true);
    expect(byName['posthog-js']?.direct).toBe(true);
  });

  it('marks packages absent from importers as indirect', () => {
    expect(byName.qs?.direct).toBe(false);
    expect(byName['@sentry/core']?.direct).toBe(false);
  });

  it('distinguishes dev-only direct dependencies', () => {
    expect(byName.vitest?.dev).toBe(true);
    expect(byName.stripe?.dev).toBe(false);
  });

  it('anchors on the package key line', () => {
    expect(byName.stripe?.snippet).toBe('stripe@17.4.0:');
  });
});

describe('parsePnpmLock: v6', () => {
  const { dependencies } = parsePnpmLock(read('pnpm-v6.pnpm-lock.yaml'), 'pnpm-lock.yaml');
  const byName = Object.fromEntries(dependencies.map((d) => [d.name, d]));

  it('reads top-level dependencies rather than importers', () => {
    expect(byName['@sentry/nextjs']?.direct).toBe(true);
    expect(byName.stripe?.direct).toBe(true);
  });

  it('handles the leading-slash key format', () => {
    expect(byName.stripe?.version).toBe('17.4.0');
  });

  it('strips peer suffixes from dev entries', () => {
    expect(byName.vitest?.version).toBe('2.1.8');
    expect(byName.vitest?.dev).toBe(true);
  });
});
