import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import ignore from 'ignore';
import { globSync } from 'tinyglobby';

/**
 * Default exclusions. `node_modules` is excluded structurally rather than by
 * configuration: Egressa never reads installed packages, so a scan is
 * deterministic, works on a fresh clone with nothing installed, and cannot be
 * influenced by whatever happens to be on disk.
 *
 * Minified and bundled output is skipped because a match inside it produces an
 * annotation nobody can act on -- the fix belongs in the source that generated it.
 */
export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/*.map',
];

export const MANIFEST_PATTERNS = [
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
];

export const SOURCE_PATTERNS = ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'];

export interface WalkOptions {
  root: string;
  exclude?: string[];
  /** Honour .gitignore and .egressaignore. On by default. */
  respectIgnoreFiles?: boolean;
}

export interface WalkResult {
  manifests: string[];
  sources: string[];
}

/** Repo-relative POSIX path, so output is identical on Windows and Linux. */
export function toPosixRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

export function walk(options: WalkOptions): WalkResult {
  const { root, exclude = [], respectIgnoreFiles = true } = options;
  const ignoreGlobs = [...DEFAULT_EXCLUDES, ...exclude];

  const filter = respectIgnoreFiles ? buildIgnoreFilter(root) : null;
  const collect = (patterns: string[]): string[] =>
    globSync(patterns, { cwd: root, ignore: ignoreGlobs, absolute: false, dot: false })
      .map((p) => p.split(sep).join('/'))
      .filter((p) => (filter ? !filter.ignores(p) : true))
      .sort();

  return { manifests: collect(MANIFEST_PATTERNS), sources: collect(SOURCE_PATTERNS) };
}

function buildIgnoreFilter(root: string): ReturnType<typeof ignore> | null {
  const matcher = ignore();
  let found = false;
  for (const name of ['.gitignore', '.egressaignore']) {
    try {
      matcher.add(readFileSync(`${root}/${name}`, 'utf8'));
      found = true;
    } catch {
      // Absent ignore files are the normal case, not an error.
    }
  }
  return found ? matcher : null;
}
