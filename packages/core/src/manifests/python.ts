import { LineIndex } from '../util/line-index.js';
import type { DependencyRecord, ManifestParseResult } from './types.js';

/**
 * Python dependency manifests: `requirements*.txt` and `pyproject.toml`.
 *
 * Declared dependencies only. A lockfile (`poetry.lock`, `uv.lock`) is not read,
 * so `--include-transitive` adds nothing for Python yet; a vendor SDK a Python
 * service declares is the case that was being missed, and it is always declared.
 *
 * Both readers refuse what they do not understand. A name reported here becomes
 * a vendor attribution at high confidence, so a line that might not be a
 * dependency yields nothing, never a guess -- the same rule `resolve-host.ts`
 * applies to hosts.
 */

/**
 * PEP 503 normalisation: lower case, and any run of `-`, `_` or `.` becomes one
 * `-`. PyPI treats `Twilio`, `twilio` and `TWILIO` as one project, so the
 * knowledge base stores the normalised form and every reader emits it.
 */
export function normalisePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Group, extra and file names that mean "not installed with the product". */
const DEV_NAME = /^(dev|develop|test|tests|testing|lint|docs|typing)$/i;

/**
 * The project name at the start of a PEP 508 requirement, and its offset.
 *
 * What may follow the name is fixed by the grammar: extras, a version specifier,
 * a parenthesised specifier, an environment marker or a direct reference.
 * Anything else -- `git+https://…`, `./local/path`, or prose such as
 * `Twilio (for SMS) is used` -- is not a requirement and yields null.
 */
function requirementName(text: string): { name: string; at: number; spec: string } | null {
  const match = /^(\s*)([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/s.exec(
    text,
  );
  if (!match) return null;
  const rest = (match[4] ?? '').trim();
  if (rest !== '' && !/^(?:[=<>!~;@]|\(\s*[=<>!~])/.test(rest)) return null;
  return {
    name: normalisePypiName(match[2] as string),
    at: (match[1] ?? '').length,
    spec: (rest.split(';')[0] ?? '').trim(),
  };
}

function record(
  index: LineIndex,
  path: string,
  offset: number,
  length: number,
  name: string,
  version: string,
  dev: boolean,
): DependencyRecord {
  return {
    name,
    version,
    ecosystem: 'pypi',
    manifestPath: path,
    loc: index.locationAt(path, offset, length),
    snippet: index.snippetAt(offset),
    direct: true,
    dev,
  };
}

// ---------------------------------------------------------------------------
// requirements.txt
// ---------------------------------------------------------------------------

/**
 * Whether a discovered `.txt` file is a requirements file at all.
 *
 * `requirements.txt`, `requirements-<x>.txt` and `requirements_<x>.txt`
 * anywhere, and any `.txt` inside a `requirements/` directory except the files
 * that live beside requirements without being one: a README or licence, notes,
 * and constraints files, which pin versions and install nothing.
 */
export function isRequirementsFile(path: string): boolean {
  const parts = path.split('/');
  const file = parts.at(-1) ?? '';
  if (!file.toLowerCase().endsWith('.txt')) return false;
  if (/^constraints/i.test(file)) return false;
  if (/^requirements([-_.].*)?\.txt$/i.test(file)) return true;
  return (
    parts.at(-2) === 'requirements' &&
    !/^(readme|license|licence|notes?|changelog|constraints)/i.test(file)
  );
}

/** `requirements-dev.txt`, `requirements_test.txt`, `requirements/lint.txt`. */
export function isDevRequirementsFile(path: string): boolean {
  const file = path.split('/').pop() ?? '';
  const stem = file.replace(/\.txt$/i, '').replace(/^requirements[-_.]?/i, '');
  return stem.split(/[-_.]/).some((part) => DEV_NAME.test(part)) && stem !== '';
}

export function parseRequirementsTxt(
  text: string,
  path: string,
  dev = isDevRequirementsFile(path),
): ManifestParseResult {
  const index = new LineIndex(text);
  const dependencies: DependencyRecord[] = [];

  let offset = 0;
  // The previous line ended in `\`, so this one continues it -- in pip-compile
  // output that is a `--hash` option, never a new requirement.
  let continuation = false;
  for (const physical of text.split('\n')) {
    const lineOffset = offset;
    offset += physical.length + 1;
    const raw = physical.endsWith('\r') ? physical.slice(0, -1) : physical;
    const continued = continuation;
    continuation = raw.trimEnd().endsWith('\\');
    if (continued) continue;

    // A comment starts at `#` at the start of the line or after whitespace;
    // `#` inside a URL fragment (`…#egg=name`) is not one, but such a line is
    // a direct reference with no leading name and is refused below anyway.
    const line = raw.replace(/(^|\s)#.*$/, '').replace(/\\\s*$/, '');
    if (line.trim() === '' || line.trim().startsWith('-')) continue;

    const requirement = requirementName(line);
    if (!requirement) continue;
    const at = lineOffset + requirement.at;
    const written = line.slice(requirement.at).match(/^[A-Za-z0-9._-]+/)?.[0] ?? '';
    dependencies.push(
      record(index, path, at, written.length, requirement.name, requirement.spec, dev),
    );
  }
  return { dependencies, errors: [] };
}

// ---------------------------------------------------------------------------
// pyproject.toml
// ---------------------------------------------------------------------------

/**
 * A TOML token. Only as much of TOML as finding dependency declarations needs:
 * enough to know where a statement starts, what its key is, and which strings
 * are elements of which array. `start` is the offset of the token's first
 * character, so a location can be reported without a TOML parser, which would
 * not give one.
 */
type Token =
  | { t: 'nl' }
  | { t: 'punct'; v: '[' | ']' | '{' | '}' | '=' | ',' | '.'; start: number }
  | { t: 'bare'; v: string; start: number }
  | { t: 'str'; v: string; start: number; multiline: boolean }
  | { t: 'other'; start: number };

/**
 * Tokenise TOML. Comments are dropped, `\r` is whitespace, and a multi-line
 * string (`"""` or `'''`) is one token however many lines it spans -- so text
 * inside a description can never be read as a key or a header. An unterminated
 * single-line string ends at the newline, as TOML requires.
 */
function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\n') {
      tokens.push({ t: 'nl' });
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
    } else if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const quote = text.slice(i, i + 3);
      let end = i + 3;
      while (end < text.length && !text.startsWith(quote, end)) {
        end += quote === '"""' && text[end] === '\\' ? 2 : 1;
      }
      // A closing run may be up to five quotes long; the extra ones are content.
      let close = end + 3;
      while (close < text.length && text[close] === quote[0] && close < end + 5) close++;
      tokens.push({ t: 'str', v: text.slice(i + 3, end), start: i, multiline: true });
      for (let k = i; k < Math.min(close, text.length); k++) {
        if (text[k] === '\n') tokens.push({ t: 'nl' });
      }
      i = close;
    } else if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < text.length && text[end] !== ch && text[end] !== '\n') {
        end += ch === '"' && text[end] === '\\' ? 2 : 1;
      }
      tokens.push({ t: 'str', v: text.slice(i + 1, end), start: i, multiline: false });
      i = text[end] === ch ? end + 1 : end;
    } else if ('[]{}=,.'.includes(ch)) {
      tokens.push({ t: 'punct', v: ch as '[' | ']' | '{' | '}' | '=' | ',' | '.', start: i });
      i++;
    } else if (/[A-Za-z0-9_-]/.test(ch)) {
      let end = i + 1;
      while (end < text.length && /[A-Za-z0-9_-]/.test(text[end] as string)) end++;
      tokens.push({ t: 'bare', v: text.slice(i, end), start: i });
      i = end;
    } else {
      tokens.push({ t: 'other', start: i });
      i++;
    }
  }
  return tokens;
}

/**
 * Where a table's dependencies live, and whether they are dev-only.
 *
 * - PEP 621 `[project]` `dependencies = [...]`: runtime.
 * - PEP 621 `[project.optional-dependencies]` `<extra> = [...]`: runtime, since an
 *   extra ships with the package, unless the extra is named like a dev group.
 * - PEP 735 `[dependency-groups]` `<group> = [...]`: dev. Groups are never
 *   installed with the package.
 * - Poetry `[tool.poetry.dependencies]`: runtime, one package per key.
 *   `[tool.poetry.dev-dependencies]`: dev. `[tool.poetry.group.<g>.dependencies]`:
 *   dev when the group is named like one, runtime otherwise.
 *
 * Every other table, including every `[[array-of-tables]]`, declares nothing.
 */
type TableKind =
  | { kind: 'array-key'; key: string | null; dev: (key: string) => boolean }
  | { kind: 'poetry'; dev: boolean }
  | null;

function tableKind(table: string): TableKind {
  if (table === 'project') return { kind: 'array-key', key: 'dependencies', dev: () => false };
  if (table === 'project.optional-dependencies') {
    return { kind: 'array-key', key: null, dev: (k) => DEV_NAME.test(k) };
  }
  if (table === 'dependency-groups') return { kind: 'array-key', key: null, dev: () => true };
  if (table === 'tool.poetry.dependencies') return { kind: 'poetry', dev: false };
  if (table === 'tool.poetry.dev-dependencies') return { kind: 'poetry', dev: true };
  const group = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(table);
  if (group) return { kind: 'poetry', dev: DEV_NAME.test(group[1] as string) };
  return null;
}

export function parsePyprojectToml(text: string, path: string): ManifestParseResult {
  const index = new LineIndex(text);
  const dependencies: DependencyRecord[] = [];
  const tokens = tokenise(text);

  let table: TableKind = null;
  let i = 0;

  /** Skip to the token after the next newline. */
  const toLineEnd = () => {
    while (i < tokens.length && tokens[i]?.t !== 'nl') i++;
  };

  /** The index just past a value starting at `from`, spanning lines when bracketed. */
  const valueEnd = (from: number): number => {
    const first = tokens[from];
    if (first?.t === 'punct' && (first.v === '[' || first.v === '{')) {
      let depth = 0;
      for (let k = from; k < tokens.length; k++) {
        const tok = tokens[k];
        if (tok?.t !== 'punct') continue;
        if (tok.v === '[' || tok.v === '{') depth++;
        else if (tok.v === ']' || tok.v === '}') depth--;
        if (depth === 0) return k + 1;
      }
      return tokens.length;
    }
    let k = from;
    while (k < tokens.length && tokens[k]?.t !== 'nl') k++;
    return k;
  };

  /**
   * Each requirement string that is a direct element of the array starting at
   * `from` -- not one inside a nested inline table such as PEP 735's
   * `{include-group = "test"}`, and never a multi-line string.
   */
  const readArray = (from: number, to: number, dev: boolean) => {
    let depth = 0;
    for (let k = from; k < to; k++) {
      const tok = tokens[k];
      if (tok?.t === 'punct' && (tok.v === '[' || tok.v === '{')) depth++;
      else if (tok?.t === 'punct' && (tok.v === ']' || tok.v === '}')) depth--;
      else if (tok?.t === 'str' && depth === 1 && !tok.multiline) {
        const requirement = requirementName(tok.v);
        if (!requirement) continue;
        const written = tok.v.slice(requirement.at).match(/^[A-Za-z0-9._-]+/)?.[0] ?? '';
        dependencies.push(
          record(
            index,
            path,
            tok.start + 1 + requirement.at,
            written.length,
            requirement.name,
            requirement.spec,
            dev,
          ),
        );
      }
    }
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok?.t === 'nl') {
      i++;
      continue;
    }

    // A header. `[[...]]` is an array of tables and declares nothing here,
    // but it does end the table before it -- which is what was missed.
    if (tok?.t === 'punct' && tok.v === '[') {
      const next = tokens[i + 1];
      if (next?.t === 'punct' && next.v === '[') {
        table = null;
        toLineEnd();
        continue;
      }
      const name: string[] = [];
      let k = i + 1;
      let ok = true;
      for (; k < tokens.length; k++) {
        const part = tokens[k];
        if (part?.t === 'punct' && part.v === ']') break;
        if (part?.t === 'bare' || (part?.t === 'str' && !part.multiline)) name.push(part.v);
        else if (!(part?.t === 'punct' && part.v === '.')) {
          ok = false;
          break;
        }
      }
      table = ok ? tableKind(name.join('.')) : null;
      toLineEnd();
      continue;
    }

    // A key, possibly dotted, then `=`.
    const parts: { v: string; start: number }[] = [];
    let k = i;
    while (k < tokens.length) {
      const part = tokens[k];
      if (part?.t === 'bare' || (part?.t === 'str' && !part.multiline)) {
        parts.push({ v: part.v, start: part.start + (part.t === 'str' ? 1 : 0) });
        k++;
        const dot = tokens[k];
        if (dot?.t === 'punct' && dot.v === '.') {
          k++;
          continue;
        }
      }
      break;
    }
    const equals = tokens[k];
    if (parts.length === 0 || !(equals?.t === 'punct' && equals.v === '=')) {
      toLineEnd();
      continue;
    }
    const valueStart = k + 1;
    const end = valueEnd(valueStart);
    const head = parts[0] as { v: string; start: number };

    if (table?.kind === 'poetry') {
      // `twilio = "^9"`, `twilio = { version = "^9" }`, or the dotted
      // `twilio.version = "^9"`: the first part names the package either way.
      if (head.v !== 'python') {
        const value = tokens[valueStart];
        const version = parts.length === 1 && value?.t === 'str' ? value.v : '';
        dependencies.push(
          record(
            index,
            path,
            head.start,
            head.v.length,
            normalisePypiName(head.v),
            version,
            table.dev,
          ),
        );
      }
    } else if (table?.kind === 'array-key' && parts.length === 1) {
      const value = tokens[valueStart];
      if ((table.key === null || head.v === table.key) && value?.t === 'punct' && value.v === '[') {
        readArray(valueStart, end, table.dev(head.v));
      }
    }

    i = end;
    toLineEnd();
  }

  return { dependencies, errors: [] };
}
