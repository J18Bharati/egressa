import type { Finding, ScanResult } from '@egressa/core';
import { DISCLAIMER, displayName } from '@egressa/core';

/**
 * Markdown summary, shared by `--format markdown` and the MCP server's
 * summarised output. Kept in one place so the CLI and an agent never disagree
 * about what a scan said.
 */
export function formatMarkdown(result: ScanResult, options: { maxFindings?: number } = {}): string {
  const max = options.maxFindings ?? Number.POSITIVE_INFINITY;
  const shown = result.findings.slice(0, max);
  const lines: string[] = [];

  lines.push('## Cross-border transfer exposure', '');
  lines.push(
    `${result.summary.findingCount} finding(s) across ${result.summary.vendorCount} vendor(s). ` +
      `Knowledge base ${result.kb.version}, adequacy status as of ${result.kb.adequacyStatusAsOf}.`,
    '',
  );

  if (result.scan.assumedAdequacyLapsed?.length) {
    lines.push(
      `> Hypothetical run: ${result.scan.assumedAdequacyLapsed.join(', ')} treated as withdrawn.`,
      '',
    );
  }

  if (shown.length > 0) {
    lines.push('| Vendor | Reason | Processing | EU region | Rule | Confidence |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of shown) {
      lines.push(
        `| ${displayName(f)} | ${reasonCell(f)} ` +
          `| ${f.transfer?.jurisdictions.join(', ') ?? 'unknown'} ` +
          `| ${euRegionCell(f)} | \`${f.ruleId}\` | ${f.confidence} |`,
      );
    }
    lines.push('');
  }

  if (result.findings.length > shown.length) {
    lines.push(`_${result.findings.length - shown.length} further finding(s) not shown._`, '');
  }

  for (const f of shown) {
    lines.push(`### ${displayName(f)}`, '');
    if (f.transfer) {
      lines.push(`- Processing: ${f.transfer.jurisdictions.join(', ')}`);
      lines.push(`- EU region: ${euRegionCell(f)}`);
      if (f.transfer.dpaUrl) lines.push(`- [Data processing agreement](${f.transfer.dpaUrl})`);
      if (f.transfer.subprocessorsUrl) {
        lines.push(`- [Sub-processors](${f.transfer.subprocessorsUrl})`);
      }
      lines.push(`- Entry last verified: ${f.transfer.lastVerified}`);
      if (f.transfer.disputed) lines.push(`- **Disputed:** ${f.transfer.disputed.summary}`);
    }
    lines.push('', 'Evidence:', '');
    for (const e of f.evidence.slice(0, 5)) {
      lines.push(`- \`${e.file}:${e.startLine}\` matched \`${e.matchedOn}\` (${e.kind})`);
    }
    lines.push('', f.remediation.summary, '');
  }

  if (result.unmatched.hosts.length > 0 || result.unmatched.packages.length > 0) {
    lines.push('### Not in the knowledge base', '');
    for (const h of result.unmatched.hosts) lines.push(`- \`${h}\``);
    for (const p of result.unmatched.packages) lines.push(`- \`${p}\``);
    lines.push('', 'No entry exists for these, so no jurisdiction can be reported.', '');
  }

  lines.push('---', '', DISCLAIMER);
  return lines.join('\n');
}

/**
 * The Vendor column carries `displayName()`, which is deliberately generic
 * for a finding with no vendor -- that is the whole point of Task 1. This
 * column is where the diagnostic detail goes instead: for
 * `transfer/unresolved-egress`, `evidence[].matchedOn` already IS the
 * unresolved reason (see `callsites/index.ts`'s `toHit()`), so surfacing it
 * here does not require reading `signals[].unresolvedReason` -- and for
 * `transfer/unknown-vendor-egress` it is the resolved host that had no
 * knowledge base entry. A finding with a matched vendor gets an empty cell:
 * there is nothing undecided left to say.
 */
function reasonCell(finding: Finding): string {
  if (finding.vendor) return '';
  const reasons = [...new Set(finding.evidence.map((e) => e.matchedOn))];
  return reasons.join('; ');
}

function euRegionCell(finding: Finding): string {
  const eu = finding.transfer?.euRegion;
  if (!eu) return 'unknown';
  if (!eu.available) return 'not documented';
  return `available (${eu.scope ?? 'scope not recorded'})`;
}
