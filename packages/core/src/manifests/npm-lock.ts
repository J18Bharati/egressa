import { type Node, parseTree } from 'jsonc-parser';
import { LineIndex } from '../util/line-index.js';
import type { DependencyRecord, LockfileKind, ManifestParseResult } from './types.js';

/**
 * npm lockfile parser covering lockfileVersion 1, 2 and 3.
 *
 * v1 carries a nested `dependencies` tree. v2 carries both that tree and the
 * flat `packages` map. v3 carries only `packages`. When both are present we read
 * `packages`: it is authoritative, records dev/optional flags per entry, and
 * does not require walking a nested structure to recover a package name.
 *
 * Everything here is recorded as `direct: false`. The lockfile does not know
 * which dependencies a human declared -- only package.json does -- so the merge
 * layer promotes records that also appear in a manifest.
 */
export function parseNpmLock(text: string, manifestPath: string): ManifestParseResult {
  const index = new LineIndex(text);
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root || root.type !== 'object') {
    return {
      dependencies: [],
      errors: [{ file: manifestPath, message: 'not a JSON object', fatal: false }],
    };
  }

  const version = numberProperty(root, 'lockfileVersion') ?? 1;
  const packages = propertyValue(root, 'packages');
  const kind: LockfileKind = version >= 3 ? 'npm-v3' : version === 2 ? 'npm-v2' : 'npm-v1';

  if (packages && packages.type === 'object') {
    return { dependencies: fromPackagesMap(packages, index, manifestPath), errors: [] };
  }

  const tree = propertyValue(root, 'dependencies');
  if (tree && tree.type === 'object') {
    const deps: DependencyRecord[] = [];
    walkV1Tree(tree, index, manifestPath, [], deps);
    return { dependencies: deps, errors: [] };
  }

  return {
    dependencies: [],
    errors: [
      { file: manifestPath, message: `${kind}: no packages or dependencies block`, fatal: false },
    ],
  };
}

/** v2/v3: keys look like "node_modules/a" or "node_modules/a/node_modules/b". */
function fromPackagesMap(
  packages: Node,
  index: LineIndex,
  manifestPath: string,
): DependencyRecord[] {
  const out: DependencyRecord[] = [];
  for (const prop of packages.children ?? []) {
    const key = prop.children?.[0]?.value;
    const entry = prop.children?.[1];
    if (typeof key !== 'string' || key === '' || !entry || entry.type !== 'object') continue;
    if (key.startsWith('node_modules/') === false) continue; // workspace links, not registry deps

    const segments = key.split('node_modules/');
    const name = segments[segments.length - 1];
    if (!name) continue;
    // Everything before the final segment is the nesting chain that led here.
    const via = segments
      .slice(1, -1)
      .map((s) => s.replace(/\/$/, ''))
      .filter(Boolean);

    out.push({
      name,
      version: stringProperty(entry, 'version') ?? '*',
      ecosystem: 'npm',
      manifestPath,
      loc: index.locationAt(manifestPath, prop.offset, prop.length),
      snippet: index.snippetAt(prop.offset),
      direct: false,
      dev: booleanProperty(entry, 'dev') ?? false,
      ...(via.length > 0 ? { transitiveVia: via } : {}),
    });
  }
  return out;
}

/** v1: a recursive `dependencies` object keyed by package name. */
function walkV1Tree(
  node: Node,
  index: LineIndex,
  manifestPath: string,
  via: string[],
  out: DependencyRecord[],
): void {
  for (const prop of node.children ?? []) {
    const name = prop.children?.[0]?.value;
    const entry = prop.children?.[1];
    if (typeof name !== 'string' || !entry || entry.type !== 'object') continue;

    out.push({
      name,
      version: stringProperty(entry, 'version') ?? '*',
      ecosystem: 'npm',
      manifestPath,
      loc: index.locationAt(manifestPath, prop.offset, prop.length),
      snippet: index.snippetAt(prop.offset),
      direct: false,
      dev: booleanProperty(entry, 'dev') ?? false,
      ...(via.length > 0 ? { transitiveVia: [...via] } : {}),
    });

    const nested = propertyValue(entry, 'dependencies');
    if (nested && nested.type === 'object') {
      walkV1Tree(nested, index, manifestPath, [...via, name], out);
    }
  }
}

function propertyValue(object: Node, key: string): Node | undefined {
  for (const prop of object.children ?? []) {
    if (prop.children?.[0]?.value === key) return prop.children[1];
  }
  return undefined;
}
function stringProperty(o: Node, k: string): string | undefined {
  const v = propertyValue(o, k)?.value;
  return typeof v === 'string' ? v : undefined;
}
function numberProperty(o: Node, k: string): number | undefined {
  const v = propertyValue(o, k)?.value;
  return typeof v === 'number' ? v : undefined;
}
function booleanProperty(o: Node, k: string): boolean | undefined {
  const v = propertyValue(o, k)?.value;
  return typeof v === 'boolean' ? v : undefined;
}
