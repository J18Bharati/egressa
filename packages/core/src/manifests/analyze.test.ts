import { describe, expect, it } from 'vitest';
import { walk } from '../discovery/walk.js';
import { analyzeManifests } from './index.js';

const root = 'fixtures/repos/express-stripe-sendgrid';

describe('analyzeManifests', () => {
  const { manifests } = walk({ root });

  it('discovers both the manifest and the lockfile', () => {
    expect(manifests).toEqual(['package-lock.json', 'package.json']);
  });

  it('reports declared dependencies by default and hides transitive ones', () => {
    const { dependencies } = analyzeManifests({ root, manifestPaths: manifests });
    const names = [...new Set(dependencies.map((d) => d.name))].sort();
    expect(names).toEqual(['@sendgrid/mail', 'express', 'stripe', 'vitest']);
    // qs and @sendgrid/client are resolved but not declared.
    expect(names).not.toContain('qs');
    expect(names).not.toContain('@sendgrid/client');
  });

  it('keeps evidence from both package.json and the lockfile', () => {
    const { dependencies } = analyzeManifests({ root, manifestPaths: manifests });
    const stripeHits = dependencies.filter((d) => d.name === 'stripe');
    expect(stripeHits.map((d) => d.manifestPath).sort()).toEqual([
      'package-lock.json',
      'package.json',
    ]);
  });

  it('projects declared-ness from package.json onto lockfile records', () => {
    const { dependencies } = analyzeManifests({ root, manifestPaths: manifests });
    const fromLock = dependencies.find(
      (d) => d.name === 'stripe' && d.manifestPath === 'package-lock.json',
    );
    expect(fromLock?.direct).toBe(true);
  });

  it('includes transitive dependencies only when asked', () => {
    const { dependencies } = analyzeManifests({
      root,
      manifestPaths: manifests,
      includeTransitive: true,
    });
    expect(dependencies.map((d) => d.name)).toContain('qs');
  });

  it('drops dev dependencies when asked', () => {
    const { dependencies } = analyzeManifests({
      root,
      manifestPaths: manifests,
      includeDev: false,
    });
    expect(dependencies.map((d) => d.name)).not.toContain('vitest');
  });

  it('is deterministic: repeated runs produce identical output', () => {
    const a = analyzeManifests({ root, manifestPaths: manifests });
    const b = analyzeManifests({ root, manifestPaths: manifests });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('walk', () => {
  it('never returns anything inside node_modules', () => {
    const { manifests, sources } = walk({ root: '.' });
    expect([...manifests, ...sources].some((p) => p.includes('node_modules'))).toBe(false);
  });
});
