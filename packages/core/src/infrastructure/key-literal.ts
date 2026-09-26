import { LineIndex } from '../util/line-index.js';
import type { InfraRecord } from './types.js';

export interface KeyLiteralOptions {
  /** `hcl` for Terraform, `toml` for `fly.toml`. The two disagree on strings and comments. */
  language: 'hcl' | 'toml';
  /**
   * When set, only assignments at the top level of a `block "<provider>"` are
   * read. When absent the file is TOML, and only keys before its first table
   * header are read.
   */
  insideBlockNamed?: string;
}

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
 * `var.region`, an interpolation, a template directive -- yields nothing at all
 * rather than a guess, which is the same rule `resolve-host.ts` applies to hosts.
 *
 * Four rules decide which assignments count, and each exists because the reader
 * once reported a region the file did not declare:
 *
 * - The key must stand alone. It is preceded by the start of the line or by a
 *   character that cannot be part of a key, and in both HCL and TOML a key may
 *   hold letters, digits, `_` and `-`. Without that, `sts_region = "us-east-1"`,
 *   a real argument of the AWS provider, was read as the provider's region.
 * - Only code counts, and the state that says what is code carries from one
 *   line to the next. That state covers:
 *   - HCL strings, `${...}` and `%{...}` inside them (with the `$${` and `%%{`
 *     escapes), `#`, `//` and `/* ... *\/` comments, and heredocs from `<<ID` or
 *     `<<-ID` to the line holding only `ID`;
 *   - TOML basic and literal strings, `"""` and `'''` multi-line strings, and `#`
 *     comments.
 *
 *   A key or a brace inside any of them is ignored. A heredoc that writes a
 *   `provider "aws"` block, or a `"` inside a template directive, otherwise
 *   produced a region at high confidence that no provider in the file declares.
 * - Inside a named block, only the block's own level counts, and only until the
 *   block closes. The depth is taken at the key's column, not the line's start,
 *   so the one-liner `provider "aws" { region = "ca-central-1" }` is read while
 *   `default_tags { tags = { region = "emea" } }` is not, and a `}` that closes
 *   the provider mid-line ends it there rather than at the end of the line.
 * - In TOML, `primary_region` is a top-level key. It is read only as the first
 *   code on a line, and only before the first line opening with `[`. So
 *   `[env]`, dotted keys and inline tables are never read as the app's region.
 *
 * Every rule fails towards hiding a region. An unterminated heredoc or string
 * hides the rest of the file. A line inside a multi-line TOML array that opens
 * with `[` ends the top level early. Both are recorded in `docs/LIMITATIONS.md`
 * and pinned by tests, so lifting either is a decision, not an accident.
 */
export function regionsFromKeyLiterals(
  text: string,
  filePath: string,
  keys: string[],
  provider: string,
  options: KeyLiteralOptions,
): InfraRecord[] {
  const { language, insideBlockNamed } = options;
  const index = new LineIndex(text);
  const out: InfraRecord[] = [];
  const value =
    language === 'toml' ? `(?:"(${literal('"')})"|'(${literal("'")})')` : `"(${literal('"')})"`;
  const matchers = keys.map(
    (key) => [key, new RegExp(`(^|[^A-Za-z0-9_.-])${key}\\s*=\\s*${value}`, 'g')] as const,
  );
  const state: ScanState = { inBlockComment: false, stack: [] };

  let offset = 0;
  let depth = 0;
  let inBlock = insideBlockNamed === undefined;
  let blockDepth = -1;

  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += line.length + 1;
    const { code, brace } = scanLine(line, state, language);
    const first = line.search(/\S/);

    // A TOML table header ends the top level, and nothing after it is the
    // app's own `primary_region`.
    if (insideBlockNamed === undefined && first !== -1 && code[first] && line[first] === '[') {
      break;
    }

    // Where the block's contents start on this line: after the header's `{` on
    // the header line itself, otherwise at column 0.
    let contentFrom = 0;
    if (insideBlockNamed !== undefined && !inBlock) {
      // `provider "aws" {` -- the quoted name decides which vendor the regions
      // inside belong to, so a file declaring two providers cannot cross them.
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
          } else if (at !== first) {
            continue;
          }
          const region = match[2] ?? match[3];
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

/**
 * The characters a literal region may hold: no quote, escape, interpolation
 * or template marker, and no brace. A value holding any of them is an
 * expression, and an expression yields nothing.
 */
function literal(quote: string): string {
  return `[^${quote}\\\\$%{}]+`;
}

type Frame = { kind: 'string'; quote: string } | { kind: 'interp'; depth: number };

interface ScanState {
  inBlockComment: boolean;
  /** Open strings and interpolations. They carry across lines. */
  stack: Frame[];
  /** The identifier ending an open HCL heredoc. */
  heredoc?: string;
  /** The delimiter of an open TOML multi-line string. */
  tomlMulti?: '"""' | "'''";
}

const HEREDOC = /^<<-?([A-Za-z_][A-Za-z0-9_-]*)/;

/**
 * Classify each column of a line: `code` is true where the character is
 * top-level code -- not inside a string, an interpolation, a heredoc or a
 * comment -- and `brace` holds +1 / -1 for a code `{` / `}`. `state` carries
 * whatever is still open at the end of the line into the next one.
 */
function scanLine(
  line: string,
  state: ScanState,
  language: 'hcl' | 'toml',
): { code: boolean[]; brace: number[] } {
  const code: boolean[] = new Array(line.length).fill(false);
  const brace: number[] = new Array(line.length).fill(0);

  // A heredoc body is text, and so is its terminator line. HCL accepts an
  // indented terminator for both `<<` and `<<-`; `trim` also drops a CR.
  if (state.heredoc !== undefined) {
    if (line.trim() === state.heredoc) state.heredoc = undefined;
    return { code, brace };
  }

  const { stack } = state;
  let i = 0;
  while (i < line.length) {
    if (state.inBlockComment) {
      if (line.startsWith('*/', i)) {
        state.inBlockComment = false;
        i += 2;
      } else i++;
      continue;
    }
    if (state.tomlMulti !== undefined) {
      const delim = state.tomlMulti;
      if (delim === '"""' && line[i] === '\\') i += 2;
      else if (line.startsWith(delim, i)) {
        // Up to two quotes before the delimiter belong to the content, so a
        // run of four or five closes the string as well.
        let run = 3;
        while (run < 5 && line[i + run] === delim[0]) run++;
        state.tomlMulti = undefined;
        i += run;
      } else i++;
      continue;
    }
    const ch = line[i] as string;
    const top = stack.at(-1);

    if (top?.kind === 'string') {
      if (ch === '\\' && (language === 'hcl' || top.quote === '"')) i += 2;
      else if (ch === top.quote) {
        stack.pop();
        i++;
      } else if (language === 'hcl' && (line.startsWith('$${', i) || line.startsWith('%%{', i))) {
        i += 3;
      } else if (language === 'hcl' && (line.startsWith('${', i) || line.startsWith('%{', i))) {
        stack.push({ kind: 'interp', depth: 0 });
        i += 2;
      } else i++;
      continue;
    }

    // Top-level code, or an expression inside `${...}` / `%{...}`.
    if (language === 'toml' && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
      state.tomlMulti = line.startsWith('"""', i) ? '"""' : "'''";
      i += 3;
      continue;
    }
    if (ch === '"' || (language === 'toml' && ch === "'")) {
      stack.push({ kind: 'string', quote: ch });
      i++;
      continue;
    }
    if (language === 'hcl') {
      const heredoc = line.slice(i).match(HEREDOC);
      if (heredoc) {
        state.heredoc = heredoc[1];
        i += heredoc[0].length;
        continue;
      }
    }
    if (!top && (ch === '#' || (language === 'hcl' && line.startsWith('//', i)))) break;
    if (!top && language === 'hcl' && line.startsWith('/*', i)) {
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
