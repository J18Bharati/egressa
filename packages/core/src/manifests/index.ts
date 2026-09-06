import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseNpmLock } from './npm-lock.js';
import { parsePackageJson } from './package-json.js';
import { parsePnpmLock } from './pnpm-lock.js';
import type { DependencyRecord, ManifestParseResult } from './types.js';
import { parseYarnBerryLock, parseYarnClassicLock } from './yarn-lock.js';

export * from './types.js';
export { parseNpmLock } from './npm-lock.js';
export { parsePackageJson } from './package-json.js';
export { parsePnpmLock } from './pnpm-lock.js';
export { parseYarnBerryLock, parseYarnClassicLock } from './yarn-lock.js';

/** Berry lockfiles are YAML and announce themselves with a `__metadata` block. */
function isBerry(text: string): boolean {
  return /^__metadata:/m.test(text);
}

export interface AnalyzeManifestsOptions {
  root: string;
  manifestPaths: string[];
  /** Include dependencies reached transitively. Off by default (precision over recall). */
  includeTransitive?: boolean;
  /** Include devDependencies. On by default, at reduced confidence. */
  includeDev?: boolean;
}

export interface ManifestAnalysis extends ManifestParseResult {
  /** Workspace member names discovered from package.json workspace globs. */
  workspaces: string[];
  manifestsScanned: number;
}

/**
 * Parses every manifest and lockfile found, then reconciles them.
 *
 * Lockfiles know versions and the full resolved tree but not what a human
 * declared; package.json knows what was declared but not what it resolved to.
 * Directness therefore comes from package.json and is projected onto lockfile
 * records, which is why a lockfile parser marking everything `direct: false`
 * is correct rather than lazy.
 */
export function analyzeManifests(options: AnalyzeManifestsOptions): ManifestAnalysis {
  const { root, manifestPaths, includeTransitive = false, includeDev = true } = options;
  const errors: ManifestParseResult['errors'] = [];
  const workspaces: string[] = [];

  const declared = new Map<string, { dev: boolean }>();
  const manifestRecords: DependencyRecord[] = [];
  const lockRecords: DependencyRecord[] = [];

  for (const path of manifestPaths) {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      errors.push({ file: path, message: `unreadable: ${(error as Error).message}`, fatal: false });
      continue;
    }

    const file = basename(path);
    if (file === 'package.json') {
      const result = parsePackageJson(text, path);
      if (result.name && path !== 'package.json') workspaces.push(result.name);
      for (const dep of result.dependencies) {
        const existing = declared.get(dep.name);
        // A package declared as a runtime dep anywhere is not dev-only.
        declared.set(dep.name, { dev: (existing?.dev ?? true) && dep.dev });
      }
      manifestRecords.push(...result.dependencies);
      errors.push(...result.errors);
      continue;
    }

    const result =
      file === 'pnpm-lock.yaml'
        ? parsePnpmLock(text, path)
        : file === 'yarn.lock'
          ? isBerry(text)
            ? parseYarnBerryLock(text, path)
            : parseYarnClassicLock(text, path)
          : parseNpmLock(text, path);

    lockRecords.push(...result.dependencies);
    errors.push(...result.errors);
  }

  // Project declared-ness from package.json onto lockfile records.
  for (const record of lockRecords) {
    const declaration = declared.get(record.name);
    if (declaration) {
      record.direct = true;
      record.dev = declaration.dev;
    }
  }

  const all = [...manifestRecords, ...lockRecords];
  const filtered = all.filter((record) => {
    if (!includeTransitive && !record.direct) return false;
    if (!includeDev && record.dev) return false;
    return true;
  });

  return {
    dependencies: dedupe(filtered),
    errors,
    workspaces,
    manifestsScanned: manifestPaths.length,
  };
}

/**
 * One record per (name, manifest, line). The same package legitimately appears
 * in both package.json and a lockfile; both locations are useful evidence, so
 * we keep both rather than collapsing to one arbitrary location.
 */
function dedupe(records: DependencyRecord[]): DependencyRecord[] {
  const seen = new Set<string>();
  const out: DependencyRecord[] = [];
  for (const record of records) {
    const key = `${record.name}|${record.manifestPath}|${record.loc.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out.sort((a, b) =>
    a.name === b.name
      ? a.manifestPath.localeCompare(b.manifestPath) || a.loc.startLine - b.loc.startLine
      : a.name.localeCompare(b.name),
  );
}
