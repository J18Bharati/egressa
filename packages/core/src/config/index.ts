import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { parse } from 'yaml';
import { excludeProblem } from '../discovery/walk.js';
import { RULE_IDS } from '../rules.js';
import type { Finding } from '../types.js';

export interface SuppressionRule {
  vendor?: string;
  rule?: string;
  reason: string;
  acceptedBy?: string;
  expires?: string;
}

export interface EgressaConfig {
  version?: number;
  exclude?: string[];
  includeTransitive?: boolean;
  failOn?: string;
  suppressions?: SuppressionRule[];
  /**
   * Where this configuration was read from, relative to the scan root. Set by
   * `loadConfig`, never by the file, so a surface can say that a repository
   * scoped its own scan.
   */
  source?: string;
}

/**
 * A configuration that cannot be honoured. Every surface reports it as a usage
 * error -- the CLI exits 2 and the MCP server returns a tool error -- rather
 * than as an internal failure, whatever part of loading went wrong.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Loads `.egressa.yml`. A missing config is the normal case, not an error.
 *
 * It lives in core, and `scan()` applies it, so that the CLI and the MCP server
 * cannot disagree about a repository. When only the CLI read it, an agent
 * scanning through MCP saw a team's suppressed findings unsuppressed and its
 * excluded trees scanned, with nothing to say so.
 *
 * `reason` is required on every suppression by design: a suppression without a
 * stated reason is indistinguishable from having never looked, and six months
 * later nobody can tell which it was.
 */
export function loadConfig(root: string, explicitPath?: string): EgressaConfig {
  const path = explicitPath ?? join(root, '.egressa.yml');
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    // Asking for a file by name and scanning without it would be the silent
    // widening the rest of this function exists to prevent.
    if (explicitPath !== undefined) throw new ConfigError(`${path}: no such file`);
    return {};
  }
  // A config that exists but cannot be read is an error, never "no config":
  // treating it as absent brings back every finding the team suppressed with
  // nothing to say why.
  let target: ReturnType<typeof statSync>;
  try {
    target = statSync(path);
  } catch {
    throw new ConfigError(`${path}: is a symlink that does not resolve`);
  }
  if (target.isDirectory()) throw new ConfigError(`${path}: is a directory, not a file`);

  // The repository's own config must be the repository's own file. A link
  // pointing elsewhere would have this read, and quote in an error, a file
  // the caller never asked about -- and MCP returns that text to an agent.
  // An explicit --config path is the caller's choice and is read as given.
  if (explicitPath === undefined) {
    const inside = relative(realpathSync(root), realpathSync(path));
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new ConfigError(`${path}: resolves outside the repository; not read`);
    }
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new ConfigError(`${path}: cannot be read (${code})`);
  }
  let parsed: unknown;
  try {
    parsed = parse(decode(bytes, path));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    // The parser's message quotes the offending lines after its first line.
    // Only the first line is kept: position and cause, never file content.
    const summary = ((error as Error).message.split('\n')[0] ?? '').replace(/:\s*$/, '');
    throw new ConfigError(`${path}: not valid YAML (${summary})`);
  }
  const source = relative(root, path) || path;
  if (parsed === null || parsed === undefined) return { source };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(
      `${path}: must be a mapping of settings such as exclude and suppressions`,
    );
  }
  const config = parsed as Record<string, unknown>;
  // An unknown key is refused rather than ignored. `expiry:` for `expires:`
  // was silently dropped, and so was a YAML merge key, which YAML 1.2 reads
  // as an ordinary key: either one left a temporary acceptance permanent.
  refuseUnknownKeys(config, TOP_LEVEL_KEYS, path);

  if (config.version !== undefined && config.version !== null && config.version !== 1) {
    throw new ConfigError(`${path}: version must be 1`);
  }

  // `exclude: legacy/**` is one glob, not a list of characters to spread.
  const exclude = config.exclude;
  if (typeof exclude === 'string') config.exclude = [exclude];
  else if (exclude !== undefined && exclude !== null && !Array.isArray(exclude)) {
    throw new ConfigError(`${path}: exclude must be a glob or a list of globs`);
  }
  // Checked here rather than left to scan(), which throws a TypeError that a
  // surface cannot tell from a knowledge base that failed to load.
  const excludeError = excludeProblem((config.exclude as string[] | null | undefined) ?? []);
  if (excludeError) throw new ConfigError(`${path}: ${excludeError}`);

  const transitive = config.includeTransitive;
  if (transitive !== undefined && transitive !== null && typeof transitive !== 'boolean') {
    throw new ConfigError(`${path}: includeTransitive must be true or false`);
  }
  // Checked here, not only where the CLI reads it, so the same file is valid
  // or invalid on every surface.
  const failOn = config.failOn;
  if (
    failOn !== undefined &&
    failOn !== null &&
    !(FAIL_ON_LEVELS as readonly unknown[]).includes(failOn)
  ) {
    throw new ConfigError(`${path}: failOn must be one of ${FAIL_ON_LEVELS.join(', ')}`);
  }

  // Every field of a suppression reaches the findings document and SARIF as
  // written, so anything that is not the declared type is refused here rather
  // than published. An expiry that is not a date used to compare as NaN and
  // never expire, which made a temporary acceptance permanent.
  const suppressions = config.suppressions;
  if (suppressions !== undefined && suppressions !== null && !Array.isArray(suppressions)) {
    throw new ConfigError(`${path}: suppressions must be a list`);
  }
  for (const [index, entry] of ((suppressions ?? []) as unknown[]).entries()) {
    const at = `${path}: suppression ${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${at} must be a mapping`);
    }
    const s = entry as Record<string, unknown>;
    refuseUnknownKeys(s, SUPPRESSION_KEYS, at);
    if (typeof s.reason !== 'string' && s.reason !== undefined && s.reason !== null) {
      throw new ConfigError(`${at}: reason must be text`);
    }
    if (typeof s.reason !== 'string' || s.reason.trim() === '') {
      throw new ConfigError(`${at} has no reason. Every suppression must say why it was accepted.`);
    }
    for (const field of ['vendor', 'rule', 'acceptedBy', 'expires'] as const) {
      if (s[field] !== undefined && typeof s[field] !== 'string') {
        throw new ConfigError(`${at}: ${field} must be text`);
      }
    }
    if (s.vendor === undefined && s.rule === undefined) {
      throw new ConfigError(`${at} names neither a vendor nor a rule, so it would match nothing`);
    }
    if (typeof s.expires === 'string' && expiryInstant(s.expires) === null) {
      throw new ConfigError(
        `${at}: expires must be a date such as 2027-01-31, or a time with a zone such as 2027-01-31T17:00Z`,
      );
    }
  }
  return { ...(config as EgressaConfig), source };
}

/** The levels `failOn` and `--fail-on` accept. */
export const FAIL_ON_LEVELS = ['none', 'note', 'warning', 'error'] as const;
export type FailOnLevel = (typeof FAIL_ON_LEVELS)[number];

const TOP_LEVEL_KEYS = ['version', 'exclude', 'includeTransitive', 'failOn', 'suppressions'];
const SUPPRESSION_KEYS = ['vendor', 'rule', 'reason', 'acceptedBy', 'expires'];

function refuseUnknownKeys(value: Record<string, unknown>, allowed: string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (key === '<<') {
      throw new ConfigError(`${at}: merge keys are not supported; write each setting out in full`);
    }
    // A key is quoted back only when it is a plain name, so an error never
    // repeats arbitrary file content -- MCP returns this text to an agent.
    if (!/^[\w.-]{1,40}$/.test(key)) throw new ConfigError(`${at}: an unrecognised key`);
    const near = allowed.find((name) => editDistance(name.toLowerCase(), key.toLowerCase()) <= 2);
    throw new ConfigError(`${at}: unknown key "${key}"${near ? ` (did you mean "${near}"?)` : ''}`);
  }
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * UTF-8, or a ConfigError. A UTF-16 file -- what Windows PowerShell 5.1's `>`
 * writes -- parsed as one long string and was treated as no config at all.
 */
function decode(bytes: Buffer, path: string): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new ConfigError(`${path}: is UTF-16; save it as UTF-8`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${path}: is not valid UTF-8`);
  }
}

const EXPIRY =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;

/**
 * The instant an `expires` value ends, or null when it is not one. Only ISO
 * 8601 is accepted: `Date.parse` read `01/02/2027` as 2 January and
 * `banana 12` as 2001. A date on its own holds through the end of that day in
 * UTC, which is what "expires 2027-01-31" is read to mean; a time must carry
 * its zone, because the machine running the scan is not the one that wrote it.
 */
export function expiryInstant(value: string): number | null {
  const match = EXPIRY.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] = match.map(Number);
  const date = Date.UTC(year as number, (month as number) - 1, day as number);
  const check = new Date(date);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== (month as number) - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  if (match[4] === undefined) return date + 86_400_000;
  if ((hour as number) > 23 || (minute as number) > 59 || (second || 0) > 59) return null;
  if ((zoneHour || 0) > 23 || (zoneMinute || 0) > 59) return null;
  return Date.parse(value);
}

/**
 * Applies configured suppressions.
 *
 * Suppressed findings are never removed from the result: they stay with
 * `suppressed: true` so JSON consumers can still see them and SARIF can present
 * them as dismissed rather than vanished. Deleting them would make an accepted
 * risk indistinguishable from one that was never detected.
 *
 * An expired suppression reactivates its finding and adds a separate
 * `config/expired-suppression` note directly after it, so accepted risk gets
 * revisited instead of being silenced permanently. The note sits beside its
 * finding rather than at the end of the list because a summarised view keeps
 * the first N findings, and a reminder placed last is the first thing cut.
 */
export function applySuppressions(
  findings: Finding[],
  config: EgressaConfig,
  now: Date = new Date(),
): Finding[] {
  const rules = config.suppressions ?? [];
  if (rules.length === 0) return findings;

  return findings.flatMap((finding) => {
    const rule = rules.find((r) => matches(r, finding));
    if (!rule) return [finding];

    // An expiry that is not a date was refused by loadConfig; one that reaches
    // here anyway counts as expired, so it is revisited rather than kept.
    const expired =
      rule.expires !== undefined &&
      now.getTime() >= (expiryInstant(rule.expires) ?? Number.NEGATIVE_INFINITY);
    const suppression = {
      reason: rule.reason,
      ...(rule.acceptedBy ? { acceptedBy: rule.acceptedBy } : {}),
      ...(rule.expires ? { expires: rule.expires } : {}),
      expired,
      source: 'config' as const,
    };
    const marked = { ...finding, suppressed: !expired, suppression };
    return expired ? [marked, expiredNote(finding, rule)] : [marked];
  });
}

/**
 * What is wrong with the configured suppressions, one message each, for a scan
 * to report as non-fatal errors. A suppression that matches nothing used to say
 * nothing: `vendor: Stripe` (the id is `stripe`) loaded cleanly, and the
 * reviewer reading the file believed the risk accepted while the scanner kept
 * reporting it.
 *
 * `findings` are the scan's findings before suppression. `narrowedBy` names
 * whatever made this scan see less than a full one -- a vendor filter, a
 * confidence floor, call sites not analysed -- because a suppression that
 * matches nothing in a narrowed scan may still match in a full one, and saying
 * it is stale would be a wrong fact.
 */
export function suppressionProblems(
  findings: Finding[],
  config: EgressaConfig,
  vendorIds: ReadonlySet<string>,
  narrowedBy: string[],
): string[] {
  const rules = config.suppressions ?? [];
  const problems: string[] = [];
  // The suppression each finding is taken by: the first that matches it.
  const takenBy = findings.map((finding) => rules.findIndex((rule) => matches(rule, finding)));

  for (const [index, rule] of rules.entries()) {
    const at = `suppression ${index + 1}`;
    if (rule.vendor !== undefined && !vendorIds.has(rule.vendor)) {
      const near = [...vendorIds].find((id) => id.toLowerCase() === rule.vendor?.toLowerCase());
      problems.push(
        `${at} names vendor "${rule.vendor}", which is not in the knowledge base${near ? ` (did you mean "${near}"?)` : ''}`,
      );
      continue;
    }
    if (rule.rule !== undefined && !(RULE_IDS as readonly string[]).includes(rule.rule)) {
      problems.push(`${at} names rule "${rule.rule}", which is not a rule`);
      continue;
    }
    const label = [
      ...(rule.vendor ? [`vendor ${rule.vendor}`] : []),
      ...(rule.rule ? [`rule ${rule.rule}`] : []),
    ].join(', ');
    const matched = findings.flatMap((finding, i) => (matches(rule, finding) ? [i] : []));
    if (matched.length === 0) {
      problems.push(
        narrowedBy.length > 0
          ? `${at} (${label}) matched no finding in this scan, which was narrowed (${narrowedBy.join('; ')}), so it may match in a full scan`
          : `${at} (${label}) matched no finding in this scan`,
      );
    } else if (matched.every((i) => (takenBy[i] ?? -1) < index)) {
      const earlier = Math.min(...matched.map((i) => takenBy[i] ?? 0)) + 1;
      problems.push(
        `${at} (${label}) matches nothing that suppression ${earlier} does not already take`,
      );
    }
  }
  return problems;
}

function matches(rule: SuppressionRule, finding: Finding): boolean {
  if (rule.vendor && finding.vendor?.id !== rule.vendor) return false;
  if (rule.rule && finding.ruleId !== rule.rule) return false;
  return Boolean(rule.vendor || rule.rule);
}

function expiredNote(finding: Finding, rule: SuppressionRule): Finding {
  return {
    ...finding,
    id: `${finding.id}-expired`,
    ruleId: 'config/expired-suppression',
    severity: 'note',
    suppressed: false,
    suppression: null,
    remediation: {
      summary: `The suppression for ${finding.vendor?.name ?? finding.ruleId} expired on ${rule.expires}. Review whether the original acceptance still holds, then extend or remove the entry.`,
      links: [],
    },
  };
}
