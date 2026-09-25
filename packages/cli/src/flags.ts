import type { ArgsDef } from 'citty';

export interface FlagProblems {
  /** Flags the command does not declare, or declares but not in this form. */
  unknown: string[];
  /** String flags given no value -- citty would read them as `true` and move on. */
  missingValue: string[];
}

/**
 * The flags in `argv` that citty would drop, or read differently from how they
 * look.
 *
 * citty accepts any flag at all and silently ignores the ones it does not know,
 * so `egressa scan . --exlude 'legacy/**'` scanned everything and exited 0 --
 * one missing letter and a CI run silently widened. This accepts exactly what
 * citty 0.1.6 honours, and nothing it would ignore:
 *
 * - the declared kebab-case name. Not the camelCase spelling: for a flag with a
 *   default, citty reads the kebab key first, so `--failOn note` was accepted
 *   and then ignored, which is the failure this exists to close;
 * - `--no-<name>` for a boolean, and no `=value` on a boolean at all --
 *   `--quiet=false` would be read as the truthy string "false";
 * - `--name=value` or `--name value` for a string flag, where the next token is
 *   its value only if it does not start with `-`. citty does not take a dash
 *   token as a value either, so `--exclude -legacy/**` excluded nothing: it is
 *   reported as missing its value, and `--exclude=-legacy/**` is the spelling
 *   that works;
 * - declared aliases, `--help` and `-h`. Everything after `--` is positional.
 */
export function flagProblems(argv: readonly string[], args: ArgsDef): FlagProblems {
  const booleans = new Set<string>(['help']);
  const strings = new Set<string>();
  const short = new Set(['h']);

  for (const [name, def] of Object.entries(args)) {
    if (def.type === 'positional') continue;
    if (def.type === 'boolean') booleans.add(name).add(`no-${name}`);
    else strings.add(name);
    for (const alias of ['alias' in def ? (def.alias ?? []) : []].flat()) {
      if (alias.length === 1) short.add(alias);
      else if (def.type === 'boolean') booleans.add(alias);
      else strings.add(alias);
    }
  }
  const problems: FlagProblems = { unknown: [], missingValue: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === '--') break;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (strings.has(name)) {
        if (eq !== -1) continue;
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) problems.missingValue.push(`--${name}`);
        else i++;
      } else if (!booleans.has(name) || eq !== -1) {
        problems.unknown.push(eq === -1 ? `--${name}` : token);
      }
    } else if (/^-[A-Za-z]/.test(token)) {
      // `-h`, or a run of declared short aliases. Anything else -- `-z`, or a
      // value that lost its flag like `-legacy/**` -- is named whole.
      if (![...token.slice(1)].every((letter) => short.has(letter))) {
        problems.unknown.push(token);
      }
    }
  }
  return problems;
}
