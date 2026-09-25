import type { ArgsDef } from 'citty';

/** `fail-on` -> `failOn`: citty reads a flag under either spelling. */
const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * The flags in `argv` that the command does not declare.
 *
 * citty accepts any flag at all and drops the ones it does not know, so
 * `egressa scan . --exlude 'legacy/**'` scanned everything and exited 0 -- one
 * missing letter and a CI run silently widened. Values were already validated
 * (`--fail-on bogus` exits 2); flag names were not.
 *
 * Accepted: every declared name and its camelCase spelling, `--no-<name>` for a
 * boolean (citty's own negation), declared aliases, `--help` / `-h`, and
 * `--name=value`. The token after a string flag is its value, never a flag, and
 * everything after `--` is positional.
 */
export function unknownFlags(argv: readonly string[], args: ArgsDef): string[] {
  const long = new Set(['help']);
  const short = new Set(['h']);
  const takesValue = new Set<string>();

  for (const [name, def] of Object.entries(args)) {
    if (def.type === 'positional') continue;
    const names = [name, camel(name)];
    if (def.type === 'boolean') names.push(`no-${name}`, `no${camel(`-${name}`)}`);
    for (const n of names) long.add(n);
    for (const alias of ['alias' in def ? (def.alias ?? []) : []].flat()) {
      if (alias.length === 1) short.add(alias);
      else long.add(alias);
    }
    if (def.type === 'string') for (const n of [name, camel(name)]) takesValue.add(n);
  }

  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === '--') break;
    if (token.startsWith('--')) {
      const [name = '', value] = token.slice(2).split(/=(.*)/s);
      if (!long.has(name)) unknown.push(`--${name}`);
      else if (value === undefined && takesValue.has(name)) i++;
    } else if (/^-[A-Za-z]/.test(token)) {
      for (const letter of token.slice(1)) {
        if (!short.has(letter)) unknown.push(`-${letter}`);
      }
    }
  }
  return unknown;
}
