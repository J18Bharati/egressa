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
 */
export function regionsFromKeyLiterals(
  text: string,
  filePath: string,
  keys: string[],
  provider: string,
  /** When set, only assignments inside a `block "<name>"` are read. */
  insideBlockNamed?: string,
): InfraRecord[] {
  const index = new LineIndex(text);
  const out: InfraRecord[] = [];

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
      for (const key of keys) {
        const at = line.indexOf(key);
        if (at === -1) continue;
        const assignment = line.slice(at).match(new RegExp(`^${key}\\s*=\\s*"([^"\\\\$]+)"`));
        if (!assignment?.[1]) continue;
        out.push({
          provider,
          region: assignment[1],
          loc: index.locationAt(filePath, lineOffset + at, key.length),
          snippet: index.snippetAt(lineOffset + at),
        });
      }
    }

    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (insideBlockNamed !== undefined && inBlock && depth <= blockDepth) {
      inBlock = false;
      blockDepth = -1;
    }
  }

  return out;
}
