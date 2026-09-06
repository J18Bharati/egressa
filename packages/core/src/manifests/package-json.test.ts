import { describe, expect, it } from 'vitest';
import { parsePackageJson } from './package-json.js';

const manifest = `{
  "name": "demo-app",
  "workspaces": ["packages/*"],
  "dependencies": {
    "stripe": "^17.4.0",
    "@sentry/nextjs": "8.42.0"
  },
  "devDependencies": {
    "vitest": "^2.1.8"
  },
  "peerDependencies": {
    "react": "^18"
  }
}
`;

describe('parsePackageJson', () => {
  const result = parsePackageJson(manifest, 'package.json');

  it('reads the package name and workspace globs', () => {
    expect(result.name).toBe('demo-app');
    expect(result.workspaceGlobs).toEqual(['packages/*']);
  });

  it('records runtime and dev dependencies, marking dev ones', () => {
    const byName = Object.fromEntries(result.dependencies.map((d) => [d.name, d]));
    expect(Object.keys(byName).sort()).toEqual(['@sentry/nextjs', 'stripe', 'vitest']);
    expect(byName.stripe?.dev).toBe(false);
    expect(byName.vitest?.dev).toBe(true);
  });

  it('excludes peerDependencies: declaring a peer is not shipping an integration', () => {
    expect(result.dependencies.find((d) => d.name === 'react')).toBeUndefined();
  });

  it('anchors each dependency at its own line so annotations are not file-level', () => {
    const stripe = result.dependencies.find((d) => d.name === 'stripe');
    expect(stripe?.loc.startLine).toBe(5);
    expect(stripe?.loc.startColumn).toBe(5);
    expect(stripe?.snippet).toBe('"stripe": "^17.4.0",');
  });

  it('marks everything from package.json as direct', () => {
    expect(result.dependencies.every((d) => d.direct)).toBe(true);
  });

  it('reports a non-object manifest without throwing', () => {
    const bad = parsePackageJson('[]', 'package.json');
    expect(bad.errors[0]?.message).toBe('not a JSON object');
    expect(bad.dependencies).toEqual([]);
  });
});
