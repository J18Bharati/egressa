import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { excludeProblem } from '../discovery/walk.js';
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
  if (!existsSync(path)) {
    // Asking for a file by name and scanning without it would be the silent
    // widening the rest of this function exists to prevent.
    if (explicitPath !== undefined) throw new ConfigError(`${path}: no such file`);
    return {};
  }

  let parsed: EgressaConfig | null;
  try {
    parsed = parse(readFileSync(path, 'utf8')) as EgressaConfig | null;
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') return {};

  // `exclude: legacy/**` is one glob, not a list of characters to spread.
  const exclude: unknown = parsed.exclude;
  if (typeof exclude === 'string') parsed.exclude = [exclude];
  else if (exclude !== undefined && exclude !== null && !Array.isArray(exclude)) {
    throw new ConfigError(`${path}: exclude must be a glob or a list of globs`);
  }
  // Checked here rather than left to scan(), which throws a TypeError that a
  // surface cannot tell from a knowledge base that failed to load.
  const excludeError = excludeProblem(parsed.exclude ?? []);
  if (excludeError) throw new ConfigError(`${path}: ${excludeError}`);

  const transitive: unknown = parsed.includeTransitive;
  if (transitive !== undefined && transitive !== null && typeof transitive !== 'boolean') {
    throw new ConfigError(`${path}: includeTransitive must be true or false`);
  }
  if (parsed.failOn !== undefined && parsed.failOn !== null && typeof parsed.failOn !== 'string') {
    throw new ConfigError(`${path}: failOn must be text`);
  }

  // Every field of a suppression reaches the findings document and SARIF as
  // written, so anything that is not the declared type is refused here rather
  // than published. An expiry that is not a date used to compare as NaN and
  // never expire, which made a temporary acceptance permanent.
  const suppressions: unknown = parsed.suppressions;
  if (suppressions !== undefined && suppressions !== null && !Array.isArray(suppressions)) {
    throw new ConfigError(`${path}: suppressions must be a list`);
  }
  for (const [index, entry] of ((suppressions ?? []) as unknown[]).entries()) {
    const at = `${path}: suppression ${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${at} must be a mapping`);
    }
    const s = entry as Record<string, unknown>;
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
    if (typeof s.expires === 'string' && !Number.isFinite(Date.parse(s.expires))) {
      throw new ConfigError(`${at}: expires must be a date such as 2027-01-31`);
    }
  }
  return { ...parsed, source: relative(root, path) || path };
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

    const expired = rule.expires !== undefined && Date.parse(rule.expires) < now.getTime();
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
