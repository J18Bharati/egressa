import type { Finding, ScanResult } from '@adequacy/core';
import type { AdequacyConfig, SuppressionRule } from './config.js';

/**
 * Applies configured suppressions.
 *
 * Suppressed findings are never removed from the result: they stay with
 * `suppressed: true` so JSON consumers can still see them and SARIF can present
 * them as dismissed rather than vanished. Deleting them would make an accepted
 * risk indistinguishable from one that was never detected.
 *
 * An expired suppression reactivates its finding and adds a separate
 * `config/expired-suppression` note, so accepted risk gets revisited instead of
 * being silenced permanently.
 */
export function applySuppressions(
  result: ScanResult,
  config: AdequacyConfig,
  now: Date = new Date(),
): ScanResult {
  const rules = config.suppressions ?? [];
  if (rules.length === 0) return result;

  const expiredNotes: Finding[] = [];
  const findings = result.findings.map((finding) => {
    const rule = rules.find((r) => matches(r, finding));
    if (!rule) return finding;

    const expired = rule.expires !== undefined && Date.parse(rule.expires) < now.getTime();
    if (expired) {
      expiredNotes.push(expiredNote(finding, rule));
      return {
        ...finding,
        suppressed: false,
        suppression: {
          reason: rule.reason,
          ...(rule.acceptedBy ? { acceptedBy: rule.acceptedBy } : {}),
          ...(rule.expires ? { expires: rule.expires } : {}),
          expired: true,
          source: 'config' as const,
        },
      };
    }

    return {
      ...finding,
      suppressed: true,
      suppression: {
        reason: rule.reason,
        ...(rule.acceptedBy ? { acceptedBy: rule.acceptedBy } : {}),
        ...(rule.expires ? { expires: rule.expires } : {}),
        expired: false,
        source: 'config' as const,
      },
    };
  });

  const all = [...findings, ...expiredNotes];
  return {
    ...result,
    findings: all,
    summary: {
      ...result.summary,
      findingCount: all.length,
      suppressed: all.filter((f) => f.suppressed).length,
    },
  };
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
