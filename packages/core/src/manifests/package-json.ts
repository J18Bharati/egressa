import { type Node, parseTree } from 'jsonc-parser';
import { LineIndex } from '../util/line-index.js';
import type { DependencyRecord, ManifestParseResult } from './types.js';

/** Blocks we treat as declaring a dependency the project actually ships or builds with. */
const RUNTIME_BLOCKS = ['dependencies', 'optionalDependencies'] as const;
const DEV_BLOCKS = ['devDependencies'] as const;

/**
 * peerDependencies are deliberately excluded: declaring a peer says "the host
 * app may provide this", not "this project sends data there". Including them
 * produced findings on libraries that merely support an integration.
 */

export interface PackageJsonResult extends ManifestParseResult {
  name?: string;
  /** Raw workspace globs, if this manifest declares them. */
  workspaceGlobs: string[];
}

export function parsePackageJson(
  text: string,
  manifestPath: string,
  workspace?: string,
): PackageJsonResult {
  const errors: ManifestParseResult['errors'] = [];
  const dependencies: DependencyRecord[] = [];
  const index = new LineIndex(text);

  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!root || root.type !== 'object') {
    return {
      dependencies,
      errors: [{ file: manifestPath, message: 'not a JSON object', fatal: false }],
      workspaceGlobs: [],
    };
  }

  const name = stringProperty(root, 'name');

  for (const [blocks, dev] of [
    [RUNTIME_BLOCKS, false],
    [DEV_BLOCKS, true],
  ] as const) {
    for (const block of blocks) {
      const node = propertyValue(root, block);
      if (!node || node.type !== 'object') continue;
      for (const prop of node.children ?? []) {
        const keyNode = prop.children?.[0];
        const valueNode = prop.children?.[1];
        if (!keyNode || typeof keyNode.value !== 'string') continue;
        const version = typeof valueNode?.value === 'string' ? valueNode.value : '*';
        dependencies.push({
          name: keyNode.value,
          version,
          ecosystem: 'npm',
          manifestPath,
          // Anchor on the property, so the annotation covers `"name": "^1.2.3"`.
          loc: index.locationAt(manifestPath, prop.offset, prop.length),
          snippet: index.snippetAt(prop.offset),
          direct: true,
          dev,
          ...(workspace ? { workspace } : {}),
        });
      }
    }
  }

  return { dependencies, errors, name, workspaceGlobs: readWorkspaceGlobs(root) };
}

function propertyValue(object: Node, key: string): Node | undefined {
  for (const prop of object.children ?? []) {
    if (prop.children?.[0]?.value === key) return prop.children[1];
  }
  return undefined;
}

function stringProperty(object: Node, key: string): string | undefined {
  const node = propertyValue(object, key);
  return typeof node?.value === 'string' ? node.value : undefined;
}

/** npm and yarn accept either an array or `{ packages: [...] }`. */
function readWorkspaceGlobs(root: Node): string[] {
  const node = propertyValue(root, 'workspaces');
  if (!node) return [];
  const arrayNode = node.type === 'array' ? node : propertyValue(node, 'packages');
  if (!arrayNode || arrayNode.type !== 'array') return [];
  return (arrayNode.children ?? [])
    .map((child) => child.value)
    .filter((value): value is string => typeof value === 'string');
}
