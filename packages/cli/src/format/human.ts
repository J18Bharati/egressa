import type { Finding, ScanResult } from '@egressa/core';
import {
  DISCLAIMER_SHORT,
  FACTS_MARKER,
  baselineText,
  displayName,
  factRefText,
  factsHeadline,
  isLocalVendor,
  isReferenceOnly,
} from '@egressa/core';

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

  // First, so it is read before any finding it changed.
  if (result.facts) {
    lines.push(c('yellow', factsHeadline(result.facts, printable)), '');
  }

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

  // A warning's path and message can come from the scanned repository, so no
  // control character reaches the terminal: an escape sequence in a file name
  // would otherwise clear the screen or plant a hyperlink.
  for (const error of result.errors) {
    lines.push(c('yellow', `warning: ${printable(error.file)}: ${printable(error.message)}`));
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
    lines.push(
      c(
        'yellow',
        'call-site analysis was unavailable on this platform; only dependency manifests were read',
      ),
    );
  }
  if (result.scan.exclude?.length) {
    const n = result.scan.exclude.length;
    lines.push(c('yellow', `${n} path(s) excluded from this scan`));
  }
  if (result.facts) {
    lines.push(
      c(
        'yellow',
        `${FACTS_MARKER} in ${printable(result.facts.source)}: review changes to it like code`,
      ),
    );
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
  const vendorName = printable(displayName(finding));
  // Without the region in the header, one provider configured in four regions
  // renders as four identical blocks. All of them, not the first: two regions
  // in the same country share a finding because they have the same legal
  // answer, and naming only one of them would imply the other was not found.
  // An unmapped region is marked rather than hidden: the file declares it, but
  // it narrowed nothing, and unmarked it reads as a resolved location.
  const regions = [
    ...new Set(
      finding.evidence
        .filter((e) => e.region)
        .map((e) => (e.regionUnmapped ? `${e.region} [unmapped]` : e.region)),
    ),
  ];
  const name = regions.length > 0 ? `${vendorName} (${regions.join(', ')})` : vendorName;
  const suppressed = finding.suppressed ? c('dim', ' (suppressed)') : '';
  const confidence =
    finding.confidence === 'high' ? '' : c('dim', ` [${finding.confidence} confidence]`);
  // A finding resting only on `reference` evidence -- a vendor named, never a
  // resolved call site -- is a materially weaker claim than one with a call
  // site. Flagging it here means a reader can tell without opening the JSON,
  // even when evidence is truncated below. See docs/LIMITATIONS.md.
  const referenceOnly = isReferenceOnly(finding) ? c('dim', ' [named, not called]') : '';
  // A local entry was written in the scanned repository; its dates and links
  // are not knowledge base data and must not read as if they were.
  const local = isLocalVendor(finding);
  const origin = local ? c('yellow', ' [local entry]') : '';

  const lines = [`${marker} ${c('bold', name)}${confidence}${suppressed}${referenceOnly}${origin}`];

  if (finding.transfer) {
    const eu = finding.transfer.euRegion;
    // The narrowed set when a region selected one, the full set otherwise. The
    // audit trail in exposure.inputs carries both either way.
    const narrowed = finding.exposure?.inputs
      .find((i) => i.startsWith('narrowedTo:'))
      ?.slice('narrowedTo:'.length);
    const jurisdictions = narrowed
      ? narrowed.split(',')
      : [...new Set(finding.transfer.jurisdictions)];
    lines.push(`    processing: ${jurisdictions.join(', ')}`);
    lines.push(
      `    EU region:  ${
        eu.available ? `available (${eu.scope ?? 'scope not recorded'})` : 'not documented'
      }`,
    );
    if (finding.exposure?.adequacyDependent) {
      lines.push(c('dim', '    relies on an adequacy decision that could be withdrawn'));
    }
    if (finding.transfer.disputed) {
      lines.push(c('yellow', `    disputed:   ${printable(finding.transfer.disputed.summary)}`));
    }
    lines.push(
      c(
        'dim',
        `    verified:   ${finding.transfer.lastVerified}${local ? ' (by the repository, not the knowledge base)' : ''}`,
      ),
    );
    if (local && finding.transfer.dpaUrl) {
      lines.push(c('dim', `    DPA (repository-supplied): ${printable(finding.transfer.dpaUrl)}`));
    }
    for (const ref of finding.transfer.repositoryFacts ?? []) {
      lines.push(c('yellow', `    facts:      ${factRefText(ref, printable)}`));
    }
  }
  const baseline = baselineText(finding);
  if (baseline) lines.push(c('yellow', `    rule:       ${baseline}`));

  for (const evidence of finding.evidence.slice(0, 3)) {
    // `callsite` is the expected, unmarked case -- data left here. Anything
    // else (`reference`, `dependency`, `html-script`, `infrastructure`) is a
    // weaker kind of observation and says so, so the same host string does
    // not render identically for a `fetch()` and a `new URL()`.
    const kindTag = evidence.kind === 'callsite' ? '' : ` [${evidence.kind}]`;
    lines.push(
      c('dim', `    ${evidence.file}:${evidence.startLine}  ${evidence.matchedOn}${kindTag}`),
    );
  }
  if (finding.evidence.length > 3) {
    lines.push(c('dim', `    ... and ${finding.evidence.length - 3} more`));
  }
  for (const link of finding.remediation.links.slice(0, 2)) {
    lines.push(c('dim', `    ${link.label}: ${link.url}`));
  }
  const tasks = finding.verification ?? [];
  for (const task of tasks.slice(0, 2)) {
    const where = task.where[0] ? `: ${task.where[0]}` : '';
    lines.push(c('dim', `    verify:     ${task.fact} (${task.reason})${where}`));
  }
  if (tasks.length > 2) lines.push(c('dim', `    ... and ${tasks.length - 2} more to verify`));

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

/** Control characters, C0 and C1, replaced so a line stays one line of text. */
function printable(text: string): string {
  return Array.from(text, (ch) => (isControl(ch) ? '?' : ch)).join('');
}

/** C0 and C1 controls, and the bidi overrides that reorder a line as displayed. */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
  const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  return control || bidi;
}
