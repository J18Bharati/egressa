import { LineIndex } from '../util/line-index.js';
import type { DependencyRecord, ManifestParseResult } from './types.js';

/**
 * Python dependency manifests: `requirements*.txt` and `pyproject.toml`.
 *
 * Declared dependencies only. A lockfile (`poetry.lock`, `uv.lock`) is not read,
 * so `--include-transitive` adds nothing for Python yet; a vendor SDK a Python
 * service declares is the case that was being missed, and it is always declared.
 *
 * `pyproject.toml` is read by a line reader rather than a TOML parser, on the
 * same reasoning as `infrastructure/key-literal.ts`: one field's worth of the
 * format is needed, a parser would be a new dependency, and a hand-rolled reader
 * keeps the source offsets a line annotation needs. It refuses what it does not
 * understand -- an unrecognised line yields nothing, never a guess.
 */

/**
 * PEP 503 normalisation: lower case, and any run of `-`, `_` or `.` becomes one
 * `-`. PyPI treats `Twilio`, `twilio` and `TWILIO` as one project, so the
 * knowledge base stores the normalised form and every reader emits it.
 */
export function normalisePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * The project name at the start of a PEP 508 requirement, and its offset.
 *
 * What may follow the name is fixed by the grammar -- extras, a version
 * specifier, an environment marker or a direct reference -- so anything else
 * (`git+https://…`, `https://…`, `./local/path`) is not a requirement with a
 * name and yields null rather than a truncated guess.
 */
function requirementName(text: string): { name: string; at: number; spec: string } | null {
  const match = /^(\s*)([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/s.exec(
    text,
  );
  if (!match) return null;
  const rest = (match[4] ?? '').trim();
  if (rest !== '' && !/^[=<>!~;@,(]/.test(rest)) return null;
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

/** `requirements-dev.txt`, `requirements_test.txt`, `requirements/lint.txt`. */
export function isDevRequirementsFile(path: string): boolean {
  const file = path.split('/').pop() ?? '';
  const stem = file.replace(/\.txt$/, '').replace(/^requirements/, '');
  return /(^|[-_.])(dev|develop|test|tests|testing|lint|docs|typing)$/.test(stem);
}

export function parseRequirementsTxt(
  text: string,
  path: string,
  dev = isDevRequirementsFile(path),
): ManifestParseResult {
  const index = new LineIndex(text);
  const dependencies: DependencyRecord[] = [];

  let offset = 0;
  for (const raw of text.split('\n')) {
    const lineOffset = offset;
    offset += raw.length + 1;
    // A comment starts at `#` at the start of the line or after whitespace;
    // `#` inside a URL fragment (`…#egg=name`) is not one, but such a line is
    // a direct reference with no leading name and is refused below anyway.
    const line = raw.replace(/(^|\s)#.*$/, '');
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

const DEV_GROUP = /^(dev|develop|test|tests|testing|lint|docs|typing)$/i;

/**
 * Where a table's dependencies live, and whether they are dev-only.
 *
 * - PEP 621 `[project]` `dependencies = [...]`: runtime.
 * - PEP 621 `[project.optional-dependencies]` `<extra> = [...]`: runtime, since an
 *   extra ships with the package, unless the extra is named like a dev group.
 * - PEP 735 `[dependency-groups]` `<group> = [...]`: dev. Groups are never
 *   installed with the package.
 * - Poetry `[tool.poetry.dependencies]`: runtime, one package per key.
 *   `[tool.poetry.dev-dependencies]` and `[tool.poetry.group.<g>.dependencies]`:
 *   dev, one package per key.
 */
type TableKind =
  | { kind: 'array-key'; key: string | null; dev: (key: string) => boolean }
  | { kind: 'poetry'; dev: boolean }
  | null;

function tableKind(table: string): TableKind {
  if (table === 'project') return { kind: 'array-key', key: 'dependencies', dev: () => false };
  if (table === 'project.optional-dependencies') {
    return { kind: 'array-key', key: null, dev: (k) => DEV_GROUP.test(k) };
  }
  if (table === 'dependency-groups') return { kind: 'array-key', key: null, dev: () => true };
  if (table === 'tool.poetry.dependencies') return { kind: 'poetry', dev: false };
  if (table === 'tool.poetry.dev-dependencies') return { kind: 'poetry', dev: true };
  if (/^tool\.poetry\.group\.[^.]+\.dependencies$/.test(table))
    return { kind: 'poetry', dev: true };
  return null;
}

export function parsePyprojectToml(text: string, path: string): ManifestParseResult {
  const index = new LineIndex(text);
  const dependencies: DependencyRecord[] = [];

  let table: TableKind = null;
  // Inside a `key = [` array that spans lines: whether it is dev, else null.
  let arrayDev: boolean | null = null;

  let offset = 0;
  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += line.length + 1;

    if (arrayDev !== null) {
      arrayDev = readArray(line, 0, lineOffset, arrayDev) ? arrayDev : null;
      continue;
    }

    const header = /^\s*\[\s*([^\]\s][^\]]*?)\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      table = tableKind((header[1] as string).replace(/\s+/g, '').replace(/["']/g, ''));
      continue;
    }
    if (!table) continue;

    const assignment = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*=\s*/.exec(line);
    if (!assignment) continue;
    const key = (assignment[1] ?? assignment[2] ?? assignment[3]) as string;
    const valueAt = assignment[0].length;

    if (table.kind === 'poetry') {
      if (key === 'python') continue;
      const keyAt = line.indexOf(key);
      const version = /^"([^"]*)"/.exec(line.slice(valueAt))?.[1] ?? '';
      dependencies.push(
        record(
          index,
          path,
          lineOffset + keyAt,
          key.length,
          normalisePypiName(key),
          version,
          table.dev,
        ),
      );
      continue;
    }

    if (table.key !== null && key !== table.key) continue;
    if (line[valueAt] !== '[') continue;
    const dev = table.dev(key);
    if (readArray(line, valueAt + 1, lineOffset, dev)) arrayDev = dev;
  }

  /**
   * Records every quoted requirement in `line` from `from`, and reports whether
   * the array is still open at the end of the line.
   */
  function readArray(line: string, from: number, lineOffset: number, dev: boolean): boolean {
    let i = from;
    while (i < line.length) {
      const ch = line[i] as string;
      if (ch === '#') return true;
      if (ch === ']') return false;
      if (ch === '"' || ch === "'") {
        const close = line.indexOf(ch, i + 1);
        if (close === -1) return true;
        const body = line.slice(i + 1, close);
        const requirement = requirementName(body);
        if (requirement) {
          const written = body.slice(requirement.at).match(/^[A-Za-z0-9._-]+/)?.[0] ?? '';
          dependencies.push(
            record(
              index,
              path,
              lineOffset + i + 1 + requirement.at,
              written.length,
              requirement.name,
              requirement.spec,
              dev,
            ),
          );
        }
        i = close + 1;
        continue;
      }
      i++;
    }
    return true;
  }

  return { dependencies, errors: [] };
}
