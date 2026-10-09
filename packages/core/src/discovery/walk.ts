import { relative, sep } from 'node:path';
import ignore from 'ignore';
import { globSync } from 'tinyglobby';
import { readInsideRoot } from './read-inside.js';

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
  // Installed Python packages, for the same reason as node_modules: they hold
  // every dependency's own manifests, which describe what *those* use, and an
  // editable install's pyproject.toml reads as this repository's own. Dot
  // directories (.venv, .tox, .nox) are never walked at all, and a virtualenv
  // under any other name is pruned by its pyvenv.cfg in walk().
  '**/venv/**',
  '**/site-packages/**',
  '**/dist-packages/**',
  '**/__pypackages__/**',
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
  '**/pyproject.toml',
  '**/requirements.txt',
  '**/requirements-*.txt',
  '**/requirements_*.txt',
  '**/requirements/*.txt',
];

export const SOURCE_PATTERNS = ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'];

/**
 * Deployment configuration declaring where the repository's own workloads run.
 *
 * Note these are matched and then confirmed by content, not trusted by name:
 * `vercel.json` is also the filename of this project's own Vercel vendor
 * entry, and reading a knowledge base file as a deployment config would be the
 * self-reference failure the write-time hook already has to avoid.
 */
export const INFRA_PATTERNS = [
  '**/vercel.json',
  '**/serverless.{yml,yaml}',
  '**/fly.toml',
  '**/*.tf',
];

export interface WalkOptions {
  root: string;
  exclude?: string[];
  /** Honour .gitignore and .egressaignore. On by default. */
  respectIgnoreFiles?: boolean;
}

export interface WalkResult {
  manifests: string[];
  sources: string[];
  infrastructure: string[];
}

/** Repo-relative POSIX path, so output is identical on Windows and Linux. */
export function toPosixRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * Why a list of exclude globs cannot be honoured, or null when it can.
 *
 * Discovery has no negation, so `!legacy/**` would be accepted and do nothing --
 * the scan silently wider than asked. A non-string entry (YAML reads `2024` as
 * a number) cannot be a glob at all. Every surface refuses both, through this:
 * the CLI as a usage error, the MCP server as a tool error, and `scan()` itself
 * by throwing, for anyone calling core directly.
 */
export function excludeProblem(globs: readonly unknown[]): string | null {
  const notString = globs.filter((glob) => typeof glob !== 'string');
  if (notString.length > 0) {
    return `exclude entries must be glob strings, got ${notString.map((g) => JSON.stringify(g)).join(', ')}`;
  }
  const negated = (globs as string[]).filter((glob) => glob.startsWith('!'));
  if (negated.length > 0) {
    return `exclude globs cannot be negated (${negated.join(', ')}); list only what to skip`;
  }
  return null;
}

export function walk(options: WalkOptions): WalkResult {
  const { root, exclude = [], respectIgnoreFiles = true } = options;
  // A virtualenv is recognised by the file every one of them carries, not by
  // its directory name, which is the user's choice (`env`, `py311`, ...).
  // A pyvenv.cfg at the root itself is ignored: pruning it would drop the scan.
  const virtualenvs = globSync('**/pyvenv.cfg', {
    cwd: root,
    ignore: [...DEFAULT_EXCLUDES, ...exclude],
    dot: false,
    followSymbolicLinks: false,
  })
    .map((p) =>
      p
        .split(sep)
        .join('/')
        .replace(/\/?pyvenv\.cfg$/, ''),
    )
    .filter((dir) => dir !== '')
    .map((dir) => `${dir}/**`);
  const ignoreGlobs = [...DEFAULT_EXCLUDES, ...exclude, ...virtualenvs];

  const filter = respectIgnoreFiles ? buildIgnoreFilter(root) : null;
  const collect = (patterns: string[]): string[] =>
    globSync(patterns, {
      cwd: root,
      ignore: ignoreGlobs,
      absolute: false,
      dot: false,
      // A linked directory is not descended into: `deps -> /` would walk the
      // whole filesystem. Linked files are still listed, and every reader
      // refuses one whose real path leaves the root (read-inside.ts).
      followSymbolicLinks: false,
    })
      .map((p) => p.split(sep).join('/'))
      .filter((p) => (filter ? !filter.ignores(p) : true))
      .sort();

  return {
    manifests: collect(MANIFEST_PATTERNS),
    sources: collect(SOURCE_PATTERNS),
    infrastructure: collect(INFRA_PATTERNS),
  };
}

function buildIgnoreFilter(root: string): ReturnType<typeof ignore> | null {
  const matcher = ignore();
  let found = false;
  for (const name of ['.gitignore', '.egressaignore']) {
    try {
      matcher.add(readInsideRoot(root, name));
      found = true;
    } catch {
      // Absent ignore files are the normal case, not an error.
    }
  }
  return found ? matcher : null;
}
