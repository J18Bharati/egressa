/**
 * The bundles inline third-party MIT and ISC code, whose licences must travel with every copy.
 * THIRD_PARTY_NOTICES is generated from the bundles, so this holds the committed file to the
 * committed skill bundle: a dependency added to core without rerunning the build shows up here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script, no declaration file
import { inlinedPackages } from './third-party-notices.mjs';

const root = join(import.meta.dirname, '..');
const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES'), 'utf8');
const skillBin = join(root, 'plugin/skills/privacy-review/bin');

describe('THIRD_PARTY_NOTICES', () => {
  it('reads package names from esbuild module comments, and skips workspace packages', () => {
    const source = [
      '// ../../node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js',
      '// node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/lib/a.js',
      '// ../../node_modules/.pnpm/@egressa+core@0.0.0/node_modules/@egressa/core/x.js',
      'const x = "// node_modules/.pnpm/fake@1/node_modules/fake/a.js";',
    ].join('\n');
    expect([...(inlinedPackages(source) as Map<string, string>).keys()].sort()).toEqual([
      '@scope/pkg',
      'yaml',
    ]);
  });

  it('names every package inlined in the committed skill bundle', () => {
    const bundle = readFileSync(join(skillBin, 'lib/egressa.mjs'), 'utf8');
    const names = [...(inlinedPackages(bundle) as Map<string, string>).keys()];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(notices, `${name} is inlined but missing; run pnpm build`).toMatch(
        new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@\\S+$`, 'm'),
      );
    }
  });

  it('credits the adapted axios code', () => {
    expect(notices).toContain('axios@1.12.2');
    expect(notices).toContain('Matt Zabriskie & Collaborators');
    const source = readFileSync(join(root, 'packages/core/src/callsites/index.ts'), 'utf8');
    expect(source).toContain('see THIRD_PARTY_NOTICES');
  });

  it('ships LICENSE, NOTICE and THIRD_PARTY_NOTICES beside the skill bundle, current', () => {
    for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']) {
      const path = join(skillBin, file);
      expect(existsSync(path), `${file} missing; run pnpm skill:bundle`).toBe(true);
      expect(readFileSync(path, 'utf8'), `${file} drifted; run pnpm skill:bundle`).toBe(
        readFileSync(join(root, file), 'utf8'),
      );
    }
  });

  it('is listed in the files of every package whose bundle inlines dependencies', () => {
    for (const dir of ['cli', 'mcp']) {
      const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
      expect(pkg.files).toContain('THIRD_PARTY_NOTICES');
    }
  });
});
