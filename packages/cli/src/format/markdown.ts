import type { Finding, ScanResult } from '@adequacy/core';
import { DISCLAIMER } from '@adequacy/core';

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
    lines.push('| Vendor | Processing | EU region | Rule | Confidence |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const f of shown) {
      lines.push(
        `| ${f.vendor?.name ?? f.evidence[0]?.matchedOn ?? 'unknown'} ` +
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
    lines.push(`### ${f.vendor?.name ?? f.evidence[0]?.matchedOn ?? 'Unknown destination'}`, '');
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

function euRegionCell(finding: Finding): string {
  const eu = finding.transfer?.euRegion;
  if (!eu) return 'unknown';
  if (!eu.available) return 'not documented';
  return `available (${eu.scope ?? 'scope not recorded'})`;
}
