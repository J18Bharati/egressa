import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `VERSION` at the repository root is the source of truth, and this file is what
 * makes that true rather than aspirational.
 *
 * The version was previously written out in five places and two of them had
 * already drifted: `packages/cli` and `packages/mcp` said 0.1.0 while
 * `packages/core` and `packages/kb-loader` still said 0.0.0, and the MCP server
 * carried its own `TOOL_VERSION` literal with no relationship to either. Nothing
 * compared them, so nothing noticed. `packages/cli/src/version.ts` even carried a
 * comment saying "the build stamps it from package.json", which was not happening.
 *
 * A literal in each place is the right shape -- the CLI is bundled into a single
 * file that gets copied outside its own tree, so reading a sibling `package.json`
 * at run time is the one thing guaranteed to break there. What was missing was
 * the check, not the indirection.
 */

const VERSION = readFileSync('VERSION', 'utf8').trim();

const manifests = [
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/kb-loader/package.json',
  'packages/mcp/package.json',
];

/** Each source literal, with the pattern that finds it. */
const literals: Array<[string, RegExp]> = [
  ['packages/cli/src/version.ts', /TOOL_VERSION\s*=\s*'([^']+)'/],
  ['packages/mcp/src/server.ts', /const TOOL_VERSION\s*=\s*'([^']+)'/],
];

describe('the version is stated once and everything agrees with it', () => {
  it('VERSION is a plain semver line', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const manifest of manifests) {
    it(`${manifest} matches VERSION`, () => {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
      expect({ manifest, version: pkg.version }).toEqual({ manifest, version: VERSION });
    });
  }

  for (const [file, pattern] of literals) {
    it(`${file} matches VERSION`, () => {
      const found = pattern.exec(readFileSync(file, 'utf8'))?.[1];
      // A miss here means the literal was renamed or reformatted, which is the
      // same failure as a wrong value: the check stops watching and says nothing.
      expect({ file, found }).toEqual({ file, found: VERSION });
    });
  }

  /**
   * The committed bundle carries its own copy. `skill-bundle.test.ts` already
   * compares it against `version.ts`; this pins it to VERSION too, so a bump
   * that forgets `pnpm skill:bundle` fails here rather than shipping a binary
   * that reports the previous version.
   */
  it('the committed skill bundle reports VERSION', () => {
    const bundle = JSON.parse(readFileSync('skill/privacy-review/bin/BUNDLE.json', 'utf8')) as {
      toolVersion?: string;
    };
    expect(bundle.toolVersion, 'run `pnpm build && pnpm skill:bundle`').toBe(VERSION);
  });

  /**
   * The workspace root is deliberately exempt: it is `private: true` and carries
   * no version, which is the normal shape for a pnpm workspace root. Asserted so
   * that "the root has no version" stays a decision rather than an oversight.
   */
  it('the workspace root stays private and unversioned', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8')) as {
      private?: boolean;
      version?: string;
    };
    expect(root.private).toBe(true);
    expect(root.version).toBeUndefined();
  });
});
