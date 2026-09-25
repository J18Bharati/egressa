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
 * Three rules decide which assignments count, and each exists because the
 * reader once reported a region the file did not declare:
 *
 * - The key must stand alone. It is preceded by the start of the line or by a
 *   character that cannot be part of a key, and in both HCL and TOML a key may
 *   hold letters, digits, `_` and `-`. Without that, `sts_region = "us-east-1"`,
 *   a real argument of the AWS provider, was read as the provider's region.
 * - Only code counts. Each line is scanned for strings (with HCL `${...}`
 *   interpolation inside them) and comments (`#`, `//`, and `/* ... *\/` across
 *   lines), and a key or a brace inside either is ignored. Otherwise the old
 *   region in `region = "eu-west-1" # was region = "us-east-1"` is reported, and a
 *   `}` in a tag value moves the depth and hands a tag the provider's region.
 * - Inside a named block, only the block's own level counts, and only until the
 *   block closes. The depth is taken at the key's column, not the line's start,
 *   so the one-liner `provider "aws" { region = "ca-central-1" }` is read while
 *   `default_tags { tags = { region = "emea" } }` is not, and a `}` that closes
 *   the provider mid-line ends it there rather than at the end of the line.
 *
 * What this cannot see -- a heredoc body, a string spanning lines -- can only
 * hide a region, never invent one.
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
  const scanner = { inBlockComment: false };

  let offset = 0;
  let depth = 0;
  let inBlock = insideBlockNamed === undefined;
  let blockDepth = -1;

  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += line.length + 1;
    const { code, brace } = scanLine(line, scanner);

    // Where the block's contents start on this line: after the header's `{` on
    // the header line itself, otherwise at column 0.
    let contentFrom = 0;
    if (insideBlockNamed !== undefined && !inBlock) {
      // `provider "aws" {` -- the quoted name decides which vendor the regions
      // inside belong to, so a file declaring two providers cannot cross them.
      const first = line.search(/\S/);
      const header = line.slice(Math.max(first, 0)).match(/^([a-z_]+)\s+"([^"]+)"\s*\{/);
      if (
        first !== -1 &&
        code[first] &&
        header &&
        header[1] === insideBlockNamed &&
        header[2] === provider
      ) {
        inBlock = true;
        blockDepth = depth;
        contentFrom = first + header[0].length;
      }
    }

    // Depth before each column, counting code braces only, and the column at
    // which the block closes, if it does on this line.
    const before: number[] = [];
    let running = depth;
    let closesAt = Number.POSITIVE_INFINITY;
    for (let c = 0; c < line.length; c++) {
      before.push(running);
      running += brace[c] ?? 0;
      if (inBlock && insideBlockNamed !== undefined && c >= contentFrom && running <= blockDepth) {
        closesAt = Math.min(closesAt, c);
      }
    }

    if (inBlock) {
      for (const [key, matcher] of matchers) {
        for (const match of line.matchAll(matcher)) {
          const at = match.index + (match[1] ?? '').length;
          if (!code[at]) continue;
          if (insideBlockNamed !== undefined) {
            if (at < contentFrom || at >= closesAt || before[at] !== blockDepth + 1) continue;
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

    depth = running;
    if (insideBlockNamed !== undefined && inBlock && closesAt !== Number.POSITIVE_INFINITY) {
      inBlock = false;
      blockDepth = -1;
    }
  }

  return out;
}

type Frame = { kind: 'string'; quote: string } | { kind: 'interp'; depth: number };

/**
 * Classify each column of a line: `code` is true where the character is
 * top-level code -- not inside a string, an interpolation or a comment -- and
 * `brace` holds +1 / -1 for a code `{` / `}`. A string cannot span lines in
 * either grammar this reads, so only a block comment carries over.
 */
function scanLine(
  line: string,
  state: { inBlockComment: boolean },
): { code: boolean[]; brace: number[] } {
  const code: boolean[] = new Array(line.length).fill(false);
  const brace: number[] = new Array(line.length).fill(0);
  const stack: Frame[] = [];

  let i = 0;
  while (i < line.length) {
    if (state.inBlockComment) {
      if (line.startsWith('*/', i)) {
        state.inBlockComment = false;
        i += 2;
      } else i++;
      continue;
    }
    const ch = line[i] as string;
    const top = stack.at(-1);

    if (top?.kind === 'string') {
      if (ch === '\\') i += 2;
      else if (ch === top.quote) {
        stack.pop();
        i++;
      } else if (top.quote === '"' && line.startsWith('${', i)) {
        stack.push({ kind: 'interp', depth: 0 });
        i += 2;
      } else i++;
      continue;
    }

    // Top-level code, or an expression inside `${...}`.
    if (ch === '"' || ch === "'") {
      stack.push({ kind: 'string', quote: ch });
      i++;
      continue;
    }
    if (!top && (ch === '#' || line.startsWith('//', i))) break;
    if (!top && line.startsWith('/*', i)) {
      state.inBlockComment = true;
      i += 2;
      continue;
    }
    if (top?.kind === 'interp') {
      if (ch === '{') top.depth++;
      else if (ch === '}') {
        if (top.depth === 0) stack.pop();
        else top.depth--;
      }
      i++;
      continue;
    }
    code[i] = true;
    if (ch === '{') brace[i] = 1;
    else if (ch === '}') brace[i] = -1;
    i++;
  }
  return { code, brace };
}
