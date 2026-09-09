import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

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
}

/**
 * Loads .egressa.yml. A missing config is the normal case, not an error.
 *
 * `reason` is required on every suppression by design: a suppression without a
 * stated reason is indistinguishable from having never looked, and six months
 * later nobody can tell which it was.
 */
export function loadConfig(root: string, explicitPath?: string): EgressaConfig {
  const path = explicitPath ?? join(root, '.egressa.yml');
  if (!existsSync(path)) return {};

  const parsed = parse(readFileSync(path, 'utf8')) as EgressaConfig | null;
  if (!parsed || typeof parsed !== 'object') return {};

  for (const [index, suppression] of (parsed.suppressions ?? []).entries()) {
    if (!suppression.reason || suppression.reason.trim() === '') {
      throw new Error(
        `${path}: suppression ${index + 1} has no reason. Every suppression must say why it was accepted.`,
      );
    }
  }
  return parsed;
}
