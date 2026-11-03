import type { Finding, ScanResult } from '@egressa/core';
import {
  DISCLAIMER,
  FACTS_MARKER,
  baselineText,
  displayName,
  factRefText,
  factsHeadline,
  isLocalVendor,
  isReferenceOnly,
  markdownCode,
  markdownText,
  markdownUrl,
  plainText,
} from '@egressa/core';

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

  if (result.scan.exclude?.length) {
    lines.push(`> ${result.scan.exclude.length} path(s) excluded from this scan.`, '');
  }

  // Before the table, so it is read before any finding it changed.
  if (result.facts) {
    lines.push(
      `> **${inert(factsHeadline(result.facts, plainText))}** ` +
        `Review changes to ${codeSpan(result.facts.source)} like code.`,
      '',
    );
  }

  if (shown.length > 0) {
    lines.push('| Vendor | Reason | Processing | EU region | Rule | Confidence |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of shown) {
      lines.push(
        `| ${inert(displayName(f))}${isReferenceOnly(f) ? ' (named, not called)' : ''}${originCell(f)} | ${reasonCell(f)} ` +
          `| ${f.transfer ? inert(f.transfer.jurisdictions.join(', ')) : 'unknown'} ` +
          `| ${euRegionCell(f)} | \`${f.ruleId}\` | ${f.confidence} |`,
      );
    }
    lines.push('');
  }

  if (result.findings.length > shown.length) {
    lines.push(`_${result.findings.length - shown.length} further finding(s) not shown._`, '');
  }

  for (const f of shown) {
    lines.push(
      `### ${inert(displayName(f))}${isReferenceOnly(f) ? ' (named, not called)' : ''}${originCell(f)}`,
      '',
    );
    const baseline = baselineText(f);
    if (baseline) lines.push(`> **${inert(baseline)}**`, '');
    if (f.transfer) {
      // A local entry's links and date are the repository's own.
      const supplied = isLocalVendor(f) ? ' (supplied by this repository)' : '';
      lines.push(`- Processing: ${inert(f.transfer.jurisdictions.join(', '))}`);
      lines.push(`- EU region: ${euRegionCell(f)}`);
      if (f.transfer.dpaUrl)
        lines.push(`- [Data processing agreement](${markdownUrl(f.transfer.dpaUrl)})${supplied}`);
      if (f.transfer.subprocessorsUrl) {
        lines.push(`- [Sub-processors](${markdownUrl(f.transfer.subprocessorsUrl)})${supplied}`);
      }
      lines.push(`- Entry last verified: ${f.transfer.lastVerified}${supplied}`);
      if (f.transfer.disputed) lines.push(`- **Disputed:** ${inert(f.transfer.disputed.summary)}`);
      for (const ref of f.transfer.repositoryFacts ?? []) {
        lines.push(`- Facts: ${markdownCode(factRefText(ref, plainText))}`);
      }
    }
    lines.push('', 'Evidence:', '');
    for (const e of f.evidence.slice(0, 5)) {
      lines.push(`- \`${e.file}:${e.startLine}\` matched \`${e.matchedOn}\` (${e.kind})`);
    }
    lines.push('', inert(f.remediation.summary), '');
    const tasks = f.verification ?? [];
    if (tasks.length > 0) {
      lines.push('To verify:', '');
      for (const t of tasks.slice(0, 5)) {
        const where = t.where[0] ? ` ([source](${markdownUrl(t.where[0])}))` : '';
        lines.push(`- ${t.fact}: ${t.reason}${where}`);
      }
      if (tasks.length > 5) lines.push(`- and ${tasks.length - 5} more`);
      lines.push('');
    }
  }

  if (result.unmatched.hosts.length > 0 || result.unmatched.packages.length > 0) {
    lines.push('### Not in the knowledge base', '');
    for (const h of result.unmatched.hosts) lines.push(`- \`${h}\``);
    for (const p of result.unmatched.packages) lines.push(`- \`${p}\``);
    lines.push('', 'No entry exists for these, so no jurisdiction can be reported.', '');
  }

  // Parse and config warnings: a suppression that matched nothing, a compiled
  // requirements file with nothing to attribute. The human format prints
  // these too; leaving them out here hid them from every PR comment.
  // At most twenty, as in the MCP summary: a PR comment has a length limit,
  // and a monorepo can produce one warning per manifest.
  if (result.errors.length > 0) {
    lines.push('### Warnings', '');
    for (const e of result.errors.slice(0, MAX_WARNINGS)) {
      lines.push(`- ${codeSpan(e.file)}: ${inert(e.message)}`);
    }
    if (result.errors.length > MAX_WARNINGS) {
      lines.push(`- and ${result.errors.length - MAX_WARNINGS} more`);
    }
    lines.push('');
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

/** Marks a vendor whose entry the scanned repository wrote. */
function originCell(finding: Finding): string {
  return isLocalVendor(finding) ? ` (local entry, ${FACTS_MARKER})` : '';
}

function euRegionCell(finding: Finding): string {
  const eu = finding.transfer?.euRegion;
  if (!eu) return 'unknown';
  if (!eu.available) return 'not documented';
  return `available (${eu.scope ?? 'scope not recorded'})`;
}

/**
 * A warning's path and message can come from the scanned repository, and this
 * output is posted as a PR comment. Control characters and line breaks are
 * removed and markdown punctuation escaped, so the text cannot open a heading,
 * load an image or leave its list item.
 */
function inert(text: string): string {
  return markdownText(text);
}

/** A path as a code span: no markup, no autolink, no mention inside it. */
const codeSpan = markdownCode;

const MAX_WARNINGS = 20;
