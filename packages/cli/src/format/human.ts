import type { Finding, ScanResult } from '@egressa/core';
import { DISCLAIMER_SHORT } from '@egressa/core';

/** Built at runtime so no literal control character appears in the source. */
const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
const STYLES = {
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  green: `${ESC}[32m`,
} as const;

type Style = keyof typeof STYLES;
type Colorise = (style: Style, text: string) => string;

export interface HumanOptions {
  color: boolean;
}

export function formatHuman(result: ScanResult, options: HumanOptions): string {
  const c: Colorise = (style, text) => (options.color ? `${STYLES[style]}${text}${RESET}` : text);

  const lines: string[] = [];

  if (result.findings.length === 0) {
    lines.push(c('green', 'No third-party data egress detected by the analyzers that ran.'));
    lines.push(c('dim', 'That is not a statement that none exists. Server-side proxying, hosts'));
    lines.push(c('dim', 'supplied at runtime, and vendors absent from the knowledge base are'));
    lines.push(c('dim', 'invisible to a static scan. See docs/CLAIMS.md.'));
    lines.push('');
  }

  // Grouped per vendor, because that is the unit someone acts on.
  for (const finding of result.findings) {
    lines.push(...formatFinding(finding, c));
    lines.push('');
  }

  if (result.unmatched.packages.length > 0 || result.unmatched.hosts.length > 0) {
    lines.push(c('bold', 'Not in the knowledge base'));
    for (const host of result.unmatched.hosts) lines.push(`  ${host}`);
    for (const pkg of result.unmatched.packages) lines.push(`  ${pkg}`);
    lines.push(c('dim', '  No entry exists for these, so no jurisdiction can be reported.'));
    lines.push('');
  }

  for (const error of result.errors) {
    lines.push(c('yellow', `warning: ${error.file}: ${error.message}`));
  }

  lines.push(summaryLine(result, c));
  lines.push(c('dim', kbLine(result)));

  if (result.scan.assumedAdequacyLapsed?.length) {
    lines.push(
      c(
        'yellow',
        `hypothetical: treating ${result.scan.assumedAdequacyLapsed.join(', ')} as withdrawn`,
      ),
    );
  }
  if (result.scan.engine.degraded) {
    lines.push(c('yellow', 'call-site analysis ran in degraded mode; results are less complete'));
  }
  lines.push(c('dim', DISCLAIMER_SHORT));

  return lines.join('\n');
}

function formatFinding(finding: Finding, c: Colorise): string[] {
  const marker =
    finding.severity === 'warning'
      ? c('yellow', '!')
      : finding.severity === 'error'
        ? c('red', 'x')
        : c('blue', 'i');
  const name = finding.vendor?.name ?? finding.evidence[0]?.matchedOn ?? 'unknown destination';
  const suppressed = finding.suppressed ? c('dim', ' (suppressed)') : '';
  const confidence =
    finding.confidence === 'high' ? '' : c('dim', ` [${finding.confidence} confidence]`);

  const lines = [`${marker} ${c('bold', name)}${confidence}${suppressed}`];

  if (finding.transfer) {
    const eu = finding.transfer.euRegion;
    lines.push(`    processing: ${finding.transfer.jurisdictions.join(', ')}`);
    lines.push(
      `    EU region:  ${
        eu.available ? `available (${eu.scope ?? 'scope not recorded'})` : 'not documented'
      }`,
    );
    if (finding.exposure?.adequacyDependent) {
      lines.push(c('dim', '    relies on an adequacy decision that could be withdrawn'));
    }
    if (finding.transfer.disputed) {
      lines.push(c('yellow', `    disputed:   ${finding.transfer.disputed.summary}`));
    }
    lines.push(c('dim', `    verified:   ${finding.transfer.lastVerified}`));
  }

  for (const evidence of finding.evidence.slice(0, 3)) {
    lines.push(c('dim', `    ${evidence.file}:${evidence.startLine}  ${evidence.matchedOn}`));
  }
  if (finding.evidence.length > 3) {
    lines.push(c('dim', `    ... and ${finding.evidence.length - 3} more`));
  }
  for (const link of finding.remediation.links.slice(0, 2)) {
    lines.push(c('dim', `    ${link.label}: ${link.url}`));
  }

  return lines;
}

function summaryLine(result: ScanResult, c: Colorise): string {
  const { vendorCount, findingCount } = result.summary;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return c(
    'bold',
    `${plural(findingCount, 'finding')} across ${plural(vendorCount, 'vendor')} ` +
      `(${plural(result.scan.filesScanned, 'file')}, ` +
      `${plural(result.scan.manifestsScanned, 'manifest')}, ${result.scan.durationMs}ms)`,
  );
}

function kbLine(result: ScanResult): string {
  const stale =
    result.kb.staleEntryCount > 0
      ? `, ${result.kb.staleEntryCount} entr${result.kb.staleEntryCount === 1 ? 'y' : 'ies'} not recently verified`
      : '';
  return (
    `knowledge base ${result.kb.version} (${result.kb.entryCount} vendors, ` +
    `adequacy status as of ${result.kb.adequacyStatusAsOf})${stale}`
  );
}
