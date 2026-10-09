import { isMap, isPair, isScalar, parseDocument } from 'yaml';
import { LineIndex } from '../util/line-index.js';
import type { DependencyRecord, ManifestParseResult } from './types.js';

/**
 * pnpm lockfile parser for lockfileVersion 6 and 9.
 *
 * The two differ in how package keys are shaped -- v6 writes `/name@version`,
 * v9 writes `name@version` -- and in where direct dependencies live: v6 puts
 * `dependencies` at the top level, v9 nests them under `importers` keyed by
 * workspace path. Both are handled by normalising the key and reading whichever
 * direct-dependency structure is present.
 *
 * The `yaml` package is used rather than a hand-rolled scanner because its
 * nodes carry `range`, which is what lets a lockfile hit become a line
 * annotation instead of a file-level one.
 */
export function parsePnpmLock(text: string, manifestPath: string): ManifestParseResult {
  const index = new LineIndex(text);
  const errors: ManifestParseResult['errors'] = [];

  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    return {
      dependencies: [],
      errors: [
        {
          file: manifestPath,
          // The parser's message quotes the failing line after its first one;
          // the position is enough, and the excerpt is file content.
          message: doc.errors[0]?.message.split('\n')[0] ?? 'YAML parse error',
          fatal: false,
        },
      ],
    };
  }

  const direct = collectDirectNames(
    doc.get('importers'),
    doc.get('dependencies'),
    doc.get('devDependencies'),
  );

  const packages = doc.get('packages');
  const dependencies: DependencyRecord[] = [];
  if (isMap(packages)) {
    for (const item of packages.items) {
      if (!isPair(item) || !isScalar(item.key)) continue;
      const rawKey = String(item.key.value);
      const parsed = parsePackageKey(rawKey);
      if (!parsed) continue;

      const offset = item.key.range?.[0] ?? 0;
      const length = (item.key.range?.[1] ?? offset) - offset;
      const directEntry = direct.runtime.has(parsed.name) || direct.dev.has(parsed.name);

      dependencies.push({
        name: parsed.name,
        version: parsed.version,
        ecosystem: 'npm',
        manifestPath,
        loc: index.locationAt(manifestPath, offset, length),
        snippet: index.snippetAt(offset),
        // pnpm's `packages` block is the flat resolved set; directness comes
        // from importers/dependencies, which we consulted above.
        direct: directEntry,
        dev: !direct.runtime.has(parsed.name) && direct.dev.has(parsed.name),
      });
    }
  } else {
    errors.push({ file: manifestPath, message: 'no packages block', fatal: false });
  }

  return { dependencies, errors };
}

/**
 * Splits `name@version`, `/name@version`, or `@scope/name@version` (with or
 * without a leading slash, and possibly with a peer-suffix in parentheses).
 */
export function parsePackageKey(raw: string): { name: string; version: string } | null {
  let key = raw.startsWith('/') ? raw.slice(1) : raw;
  // Drop pnpm's peer-dependency suffix: `foo@1.0.0(react@18.3.1)`
  const peerIndex = key.indexOf('(');
  if (peerIndex > 0) key = key.slice(0, peerIndex);

  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

interface DirectNames {
  runtime: Set<string>;
  dev: Set<string>;
}

function collectDirectNames(importers: unknown, deps: unknown, devDeps: unknown): DirectNames {
  const runtime = new Set<string>();
  const dev = new Set<string>();

  // v9: importers.<path>.{dependencies,devDependencies}
  if (isMap(importers)) {
    for (const importer of importers.items) {
      if (!isPair(importer)) continue;
      addNames(
        runtime,
        (importer.value as { get?: (k: string) => unknown })?.get?.('dependencies'),
      );
      addNames(dev, (importer.value as { get?: (k: string) => unknown })?.get?.('devDependencies'));
    }
  }
  // v6: top-level dependencies / devDependencies
  addNames(runtime, deps);
  addNames(dev, devDeps);

  return { runtime, dev };
}

function addNames(target: Set<string>, node: unknown): void {
  if (!isMap(node)) return;
  for (const item of node.items) {
    if (isPair(item) && isScalar(item.key)) target.add(String(item.key.value));
  }
}
