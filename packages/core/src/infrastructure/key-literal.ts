import { LineIndex } from '../util/line-index.js';
import type { InfraRecord } from './types.js';

/**
 * A region read from a `key = "literal"` assignment.
 *
 * Terraform's HCL and Fly's TOML are different languages that, for this one
 * purpose, are the same shape: a known key, an equals sign, and a quoted
 * string. Taking a dependency for either would add a parser to a deliberately
 * small tree in order to read one field, so this reads that field directly and
 * refuses everything else -- `manifests/yarn-lock.ts` sets the precedent for a
 * hand-rolled reader that tracks its own offsets.
 *
 * It is not a fallback parser. A value that is not a quoted literal -- an HCL
 * `var.region`, an interpolation, a heredoc -- yields nothing at all rather
 * than a guess, which is the same rule `resolve-host.ts` applies to hosts.
 *
 * Two rules decide which assignments count, and both exist because the reader
 * once reported a region the file did not declare:
 *
 * - The key must stand alone. It is preceded by the start of the line or by a
 *   character that cannot be part of a key, and in both HCL and TOML a key may
 *   hold letters, digits, `_` and `-`. Without that, `sts_region = "us-east-1"`,
 *   a real argument of the AWS provider, was read as the provider's region.
 * - Inside a named block, only the block's own level counts. The brace depth is
 *   taken at the key's position, not the line's start, so the one-liner
 *   `provider "aws" { region = "ca-central-1" }` is read, and
 *   `default_tags { tags = { region = "emea" } }` -- a tag, on a line or across
 *   several -- is not.
 *
 * Per line: skip comments and blanks; on `provider "<name>" {` record the depth
 * the block opened at; while inside it, examine every match on the line and keep
 * those one level below the opening; then apply the line's braces and leave the
 * block when depth falls back. A brace inside a string can only make the depth
 * read too deep, which drops a region rather than inventing one.
 */
export function regionsFromKeyLiterals(
  text: string,
  filePath: string,
  keys: string[],
  provider: string,
  /** When set, only assignments at the top level of a `block "<name>"` are read. */
  insideBlockNamed?: string,
): InfraRecord[] {
  const index = new LineIndex(text);
  const out: InfraRecord[] = [];
  const matchers = keys.map(
    (key) => [key, new RegExp(`(^|[^A-Za-z0-9_-])${key}\\s*=\\s*"([^"\\\\$]+)"`, 'g')] as const,
  );

  let offset = 0;
  let depth = 0;
  let inBlock = insideBlockNamed === undefined;
  let blockDepth = -1;

  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    if (insideBlockNamed !== undefined && !inBlock) {
      // `provider "aws" {` -- the quoted name decides which vendor the regions
      // inside belong to, so a file declaring two providers cannot cross them.
      const header = trimmed.match(/^([a-z_]+)\s+"([^"]+)"\s*\{/);
      if (header && header[1] === insideBlockNamed && header[2] === provider) {
        inBlock = true;
        blockDepth = depth;
      }
    }

    if (inBlock) {
      for (const [key, matcher] of matchers) {
        for (const match of line.matchAll(matcher)) {
          const at = match.index + (match[1] ?? '').length;
          if (insideBlockNamed !== undefined && depthAt(line, at, depth) !== blockDepth + 1) {
            continue;
          }
          const region = match[2];
          if (!region) continue;
          out.push({
            provider,
            region,
            loc: index.locationAt(filePath, lineOffset + at, key.length),
            snippet: index.snippetAt(lineOffset + at),
          });
        }
      }
    }

    depth += braces(line);
    if (insideBlockNamed !== undefined && inBlock && depth <= blockDepth) {
      inBlock = false;
      blockDepth = -1;
    }
  }

  return out;
}

/** Net `{` minus `}` in a string. */
function braces(text: string): number {
  return (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
}

/** Brace depth at a column: the line's starting depth plus what precedes it. */
function depthAt(line: string, column: number, lineStartDepth: number): number {
  return lineStartDepth + braces(line.slice(0, column));
}
