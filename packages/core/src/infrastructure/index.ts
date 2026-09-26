import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseTree } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import { LineIndex } from '../util/line-index.js';
import { regionsFromKeyLiterals } from './key-literal.js';
import type { InfraParseResult, InfraRecord } from './types.js';

export * from './types.js';

export interface AnalyzeInfrastructureOptions {
  root: string;
  configPaths: string[];
}

export interface InfraAnalysis extends InfraParseResult {
  filesScanned: number;
}

/**
 * Regions a repository declares for infrastructure it controls.
 *
 * Synchronous, reads its own files and never throws, mirroring
 * `manifests/index.ts`. An unreadable or unparseable file is an error on the
 * document, not a crash: a scan that dies on one malformed config tells the
 * user nothing about the rest of the repository.
 */
export function analyzeInfrastructure(options: AnalyzeInfrastructureOptions): InfraAnalysis {
  const { root, configPaths } = options;
  const regions: InfraRecord[] = [];
  const errors: InfraParseResult['errors'] = [];

  for (const path of configPaths) {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      errors.push({ file: path, message: `unreadable: ${(error as Error).message}`, fatal: false });
      continue;
    }

    const name = basename(path);
    try {
      if (name === 'vercel.json') regions.push(...parseVercelJson(text, path));
      else if (name === 'serverless.yml' || name === 'serverless.yaml') {
        regions.push(...parseServerlessYaml(text, path));
      } else if (name === 'fly.toml') {
        regions.push(
          ...regionsFromKeyLiterals(text, path, ['primary_region'], 'fly', { language: 'toml' }),
        );
      } else if (name.endsWith('.tf')) {
        for (const provider of ['aws', 'gcp', 'azure']) {
          regions.push(
            ...regionsFromKeyLiterals(text, path, ['region'], provider, {
              language: 'hcl',
              insideBlockNamed: 'provider',
            }),
          );
        }
      }
    } catch (error) {
      errors.push({
        file: path,
        message: `${(error as Error).message}; file skipped`,
        fatal: false,
      });
    }
  }

  return { regions, errors, filesScanned: configPaths.length };
}

/**
 * Vercel's `regions` array.
 *
 * Detected by content, never by filename alone: this repository's own
 * knowledge base contains `kb/vendors/vercel.json`, and a scan of it would
 * otherwise try to read a vendor entry as a deployment config. A privacy
 * scanner reporting its own data files is the same failure as a secret scanner
 * flagging its own fixtures.
 */
function parseVercelJson(text: string, path: string): InfraRecord[] {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root) return [];
  const regionsNode = root.children?.find((c) => c.children?.[0]?.value === 'regions');
  const values = regionsNode?.children?.[1];
  if (!values || values.type !== 'array') return [];
  // A vendor entry has an `id` and a `schemaVersion`; a Vercel config does not.
  if (root.children?.some((c) => c.children?.[0]?.value === 'schemaVersion')) return [];

  const index = new LineIndex(text);
  const out: InfraRecord[] = [];
  for (const item of values.children ?? []) {
    if (typeof item.value !== 'string') continue;
    out.push({
      provider: 'vercel',
      region: item.value,
      loc: index.locationAt(path, item.offset, item.length),
      snippet: index.snippetAt(item.offset),
    });
  }
  return out;
}

/** `provider: { name: aws, region: eu-west-1 }` in a Serverless Framework config. */
function parseServerlessYaml(text: string, path: string): InfraRecord[] {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length > 0) return [];
  const provider = doc.get('provider') as
    | { get?: (k: string) => unknown; items?: unknown[] }
    | undefined;
  if (!provider?.get) return [];
  const name = provider.get('name');
  const region = provider.get('region');
  if (typeof name !== 'string' || typeof region !== 'string') return [];

  const index = new LineIndex(text);
  // The key's own range, so the annotation lands on `region:` rather than the
  // start of the document.
  const at = text.indexOf('region', text.indexOf('provider'));
  const offset = at === -1 ? 0 : at;
  return [
    {
      provider: name,
      region,
      loc: index.locationAt(path, offset, 'region'.length),
      snippet: index.snippetAt(offset),
    },
  ];
}
