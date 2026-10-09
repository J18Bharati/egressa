import { isMap, isPair, isScalar, parseDocument } from 'yaml';
import { LineIndex } from '../util/line-index.js';
import type { DependencyRecord, ManifestParseResult } from './types.js';

/**
 * Yarn lockfile parsers.
 *
 * Classic (v1) uses a bespoke, frozen format. We tokenise it by hand rather than
 * depend on `@yarnpkg/lockfile`, which is unmaintained: the format will not
 * change again, so ~60 lines here costs less than an abandoned dependency.
 *
 * Berry (v2+) is YAML, so it goes through the same `yaml` parser as pnpm.
 */

/** Entry headers sit at column 0 and end with a colon: `stripe@^17.4.0, stripe@^17:`. */
const CLASSIC_HEADER = /^(?!\s)(.+):\s*$/;
/** `version "17.4.0"` inside an entry body. */
const CLASSIC_VERSION = /^\s+version\s+"?([^"\s]+)"?\s*$/;

export function parseYarnClassicLock(text: string, manifestPath: string): ManifestParseResult {
  const index = new LineIndex(text);
  const dependencies: DependencyRecord[] = [];
  const lines = text.split('\n');

  let offset = 0;
  let pending: { name: string; headerOffset: number; headerLength: number } | null = null;

  for (const line of lines) {
    const lineOffset = offset;
    offset += line.length + 1;

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const header = CLASSIC_HEADER.exec(line);
    if (header?.[1]) {
      // A header may list several specifiers for one resolution; they all
      // resolve to the same package, so the first is enough to name it.
      const firstSpec = header[1].split(',')[0]?.trim() ?? '';
      const name = nameFromSpecifier(firstSpec);
      pending = name
        ? { name, headerOffset: lineOffset, headerLength: line.replace(/\s+$/, '').length }
        : null;
      continue;
    }

    const version = CLASSIC_VERSION.exec(line);
    if (version?.[1] && pending) {
      dependencies.push({
        name: pending.name,
        version: version[1],
        ecosystem: 'npm',
        manifestPath,
        loc: index.locationAt(manifestPath, pending.headerOffset, pending.headerLength),
        snippet: index.snippetAt(pending.headerOffset),
        direct: false,
        dev: false, // yarn v1 lockfiles do not record dev-ness
      });
      pending = null;
    }
  }

  return { dependencies, errors: [] };
}

export function parseYarnBerryLock(text: string, manifestPath: string): ManifestParseResult {
  const index = new LineIndex(text);
  const doc = parseDocument(text);
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

  const dependencies: DependencyRecord[] = [];
  const contents = doc.contents;
  if (!isMap(contents)) return { dependencies, errors: [] };

  for (const item of contents.items) {
    if (!isPair(item) || !isScalar(item.key)) continue;
    const key = String(item.key.value);
    if (key === '__metadata') continue;

    const value = item.value as { get?: (k: string) => unknown } | null;
    const version = value?.get?.('version');
    const resolution = value?.get?.('resolution');
    // `resolution` is authoritative: "stripe@npm:17.4.0". Fall back to the key.
    const name =
      nameFromSpecifier(typeof resolution === 'string' ? resolution : '') ??
      nameFromSpecifier(key.split(',')[0]?.trim() ?? '');
    if (!name) continue;

    const offset = item.key.range?.[0] ?? 0;
    const length = (item.key.range?.[1] ?? offset) - offset;

    dependencies.push({
      name,
      version: version === undefined || version === null ? '*' : String(version),
      ecosystem: 'npm',
      manifestPath,
      loc: index.locationAt(manifestPath, offset, length),
      snippet: index.snippetAt(offset),
      direct: false,
      dev: false,
    });
  }

  return { dependencies, errors: [] };
}

/**
 * Recovers a package name from a yarn specifier.
 *
 * Handles `stripe@^17.4.0`, `"@sentry/node@^7"`, `stripe@npm:17.4.0`, and
 * `@scope/name@workspace:.` -- in every case the name is everything before the
 * last `@` that is not the scope marker at position 0.
 */
export function nameFromSpecifier(spec: string): string | null {
  const cleaned = spec.replace(/^["']|["']$/g, '').trim();
  if (!cleaned) return null;
  const at = cleaned.lastIndexOf('@');
  if (at <= 0) return cleaned.startsWith('@') ? null : cleaned;
  const name = cleaned.slice(0, at);
  return name || null;
}
