import { isAbsolute } from 'node:path';
import { DISCLAIMER } from '../claims.js';
import { RULES, RULE_IDS } from '../rules.js';
import type { Finding, ScanResult, Severity } from '../types.js';
import {
  displayName,
  isReferenceOnly,
  markdownCode,
  markdownText,
  markdownUrl,
  plainText,
} from './display.js';
import {
  FACTS_MARKER,
  baselineText,
  factRefText,
  factsHeadline,
  isLocalVendor,
  loosenedByFacts,
} from './provenance.js';

/**
 * SARIF 2.1.0 emitter.
 *
 * SARIF is the distribution channel: GitHub Code Scanning ingests it natively,
 * so findings appear as pull-request annotations without us building any UI.
 * Several details below exist specifically because of how GitHub renders it,
 * and are noted where that is the reason.
 */

const SARIF_VERSION = '2.1.0';
const SARIF_SCHEMA =
  'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const INFORMATION_URI = 'https://github.com/J18Bharati/egressa';

export interface SarifOptions {
  /** Repo-relative paths are emitted as-is; GitHub resolves them against the checkout. */
  toolVersion: string;
}

export function toSarif(result: ScanResult, options: SarifOptions): unknown {
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: 'egressa',
            version: options.toolVersion,
            semanticVersion: options.toolVersion,
            informationUri: INFORMATION_URI,
            // The claim scope travels with the output, not just the README.
            fullDescription: { text: DISCLAIMER },
            rules: RULE_IDS.map((id) => toReportingDescriptor(id, result)),
          },
        },
        automationDetails: { id: 'egressa/scan' },
        // GitHub shows this in the alert; it makes the KB version auditable.
        // `exclude` lives here rather than on individual results: it describes
        // the run, not any one finding, and a SARIF narrowed by --exclude must
        // not be byte-indistinguishable from a genuinely clean scan -- this is
        // the one place in the document that provenance can hide.
        properties: {
          kbVersion: result.kb.version,
          kbLicense: result.kb.license,
          adequacyStatusAsOf: result.kb.adequacyStatusAsOf,
          ...(result.scan.assumedAdequacyLapsed
            ? { assumedAdequacyLapsed: result.scan.assumedAdequacyLapsed }
            : {}),
          ...(result.scan.exclude?.length ? { exclude: result.scan.exclude } : {}),
          // A repository's facts file can change classifications, so a SARIF
          // shaped by it must say so where the run is described.
          ...(result.facts
            ? { facts: { ...result.facts, headline: factsHeadline(result.facts, plainText) } }
            : {}),
        },
        ...(result.errors.length > 0 ? { invocations: [toInvocation(result)] } : {}),
        results: result.findings.map((finding) => toResult(finding, result)),
      },
    ],
  };
}

/**
 * The scan's own errors, as SARIF records them: a notification per error on
 * the run's invocation. GitHub is where a CI gate is read, and a config
 * warning or a parse error shown everywhere else must not be missing there.
 */
function toInvocation(result: ScanResult) {
  return {
    executionSuccessful: !result.errors.some((e) => e.fatal),
    toolExecutionNotifications: result.errors.map((e) => ({
      level: e.fatal ? 'error' : 'warning',
      message: { text: e.message },
      // Located against the source root, like every result. A path that is the
      // machine's, or that climbs out of the root (an explicit --config), has
      // no location in the checkout to point at.
      ...(isAbsolute(e.file) || e.file.startsWith('..')
        ? {}
        : {
            locations: [
              { physicalLocation: { artifactLocation: { uri: e.file, uriBaseId: '%SRCROOT%' } } },
            ],
          }),
    })),
  };
}

function toReportingDescriptor(id: (typeof RULE_IDS)[number], result: ScanResult): unknown {
  const rule = RULES[id];
  return {
    id: rule.id,
    name: rule.name,
    shortDescription: { text: rule.shortDescription },
    fullDescription: { text: rule.fullDescription },
    defaultConfiguration: { level: rule.defaultLevel },
    // GitHub renders help.markdown in the alert detail pane. Putting the DPA
    // link, sub-processor list, sources and lastVerified here means the whole
    // evidence trail is visible in the UI at zero UI cost.
    help: {
      text: rule.help,
      markdown: buildHelpMarkdown(id, result),
    },
    properties: { tags: rule.tags },
    helpUri: `${INFORMATION_URI}/blob/main/docs/rules/${rule.name}.md`,
  };
}

function buildHelpMarkdown(id: (typeof RULE_IDS)[number], result: ScanResult): string {
  const rule = RULES[id];
  const lines: string[] = [`### ${rule.shortDescription}`, '', rule.fullDescription, '', rule.help];

  // Vendors matched by this rule in this run, with their sources. This is what
  // turns a generic rule description into an auditable claim.
  const vendors = result.findings.flatMap((f) =>
    f.ruleId === id && f.vendor && f.transfer
      ? [{ finding: f, vendor: f.vendor, transfer: f.transfer }]
      : [],
  );

  if (vendors.length > 0) {
    lines.push('', '#### Vendors matched in this scan', '');
    for (const { finding, vendor, transfer } of vendors) {
      // A local entry's links, sources and date are the repository's own, not
      // the knowledge base's, and must not read as if they were.
      const local = isLocalVendor(finding);
      const supplied = local ? ' (supplied by this repository)' : '';
      lines.push(
        `**${markdownText(vendor.name)}**${local ? ` _(vendor entry from ${FACTS_MARKER})_` : ''} — processing: ${markdownText(transfer.jurisdictions.join(', '))}`,
      );
      if (transfer.euRegion.available) {
        lines.push(`- EU region: available (${transfer.euRegion.scope ?? 'scope not recorded'})`);
      }
      if (transfer.dpaUrl) {
        lines.push(`- [Data processing agreement](${markdownUrl(transfer.dpaUrl)})${supplied}`);
      }
      if (transfer.subprocessorsUrl) {
        lines.push(`- [Sub-processors](${markdownUrl(transfer.subprocessorsUrl)})${supplied}`);
      }
      for (const source of transfer.kbSources) {
        lines.push(
          `- Source: [${markdownText(source.title)}](${markdownUrl(source.url)}) (${source.publisher})${supplied}`,
        );
      }
      lines.push(`- Last verified: ${transfer.lastVerified}${supplied}`);
      for (const ref of transfer.repositoryFacts ?? []) {
        lines.push(`- Repository fact: ${markdownCode(factRefText(ref, plainText))}`);
      }
      const baseline = baselineText(finding);
      if (baseline) lines.push(`- **${markdownText(baseline)}**`);
      if (transfer.disputed) {
        lines.push(
          `- **Disputed**: ${markdownText(transfer.disputed.summary)} ([issue](${markdownUrl(transfer.disputed.issueUrl)}))`,
        );
      }
      lines.push('');
    }
  }

  lines.push('', '---', '', DISCLAIMER);
  return lines.join('\n');
}

function toResult(finding: Finding, result: ScanResult): unknown {
  const [primary, ...related] = finding.evidence;
  return {
    ruleId: finding.ruleId,
    level: finding.severity,
    message: { markdown: buildMessage(finding), text: buildMessageText(finding) },
    locations: primary ? [toSarifLocation(primary)] : [],
    ...(related.length > 0 ? { relatedLocations: related.map(toSarifLocation) } : {}),
    // Fingerprints keep an alert from closing and reopening every time an
    // unrelated edit shifts its line number.
    partialFingerprints: { 'egressa/vendorRule/v1': finding.id },
    // GitHub sorts by rank, so severity x confidence produces a sensible order.
    rank: toRank(finding.severity, finding.confidence),
    ...(finding.suppressed && finding.suppression
      ? {
          suppressions: [{ kind: 'external', justification: finding.suppression.reason }],
        }
      : {}),
    properties: {
      vendorId: finding.vendor?.id ?? null,
      confidence: finding.confidence,
      jurisdictions: finding.transfer?.jurisdictions ?? [],
      exposure: finding.exposure
        ? {
            thirdCountryTransfer: finding.exposure.thirdCountryTransfer,
            euAlternativeAvailable: finding.exposure.euAlternativeAvailable,
            adequacyDependent: finding.exposure.adequacyDependent,
            level: finding.exposure.level,
          }
        : null,
      kbVersion: result.kb.version,
      evidenceCount: finding.evidence.length,
      ...(finding.vendor?.origin ? { vendorOrigin: finding.vendor.origin } : {}),
      ...(finding.baselineRuleId ? { baselineRuleId: finding.baselineRuleId } : {}),
      ...(finding.transfer?.repositoryFacts
        ? { repositoryFacts: finding.transfer.repositoryFacts }
        : {}),
      ...(finding.verification ? { verification: finding.verification } : {}),
    },
  };
}

/**
 * SARIF has no first-class confidence field, so a non-high confidence is
 * prefixed onto the message. Silently presenting a transitive-dependency guess
 * the same way as a resolved call site would be the dishonest option.
 */
function confidencePrefix(finding: Finding): string {
  return finding.confidence === 'high' ? '' : `[${finding.confidence} confidence] `;
}

/** The message, with names passed through `render`: plain for `text`, inert markdown for `markdown`. */
function buildMessageText(finding: Finding, render: (text: string) => string = plainText): string {
  const vendor = render(displayName(finding));
  const where = finding.transfer
    ? ` (processing: ${finding.transfer.jurisdictions.join(', ')})`
    : '';
  const count =
    finding.evidence.length > 1 ? ` ${finding.evidence.length} references in this repository.` : '';
  // A finding resting only on `reference` evidence -- a vendor named, never a
  // resolved call site -- is a materially weaker claim than one with a call
  // site, and GitHub's alert view has no other field to carry that. A short
  // note, not a sentence: see docs/LIMITATIONS.md.
  const referenceOnly = isReferenceOnly(finding) ? ' Named, not called.' : '';
  return `${factsPrefix(finding)}${confidencePrefix(finding)}${vendor}${where}.${count}${referenceOnly}${factsNote(finding)}`;
}

/**
 * A finding a repository's facts made less severe leads with that, since the
 * alert view shows the message before anything else and a quiet note at the
 * end would read as the knowledge base's own answer.
 */
function factsPrefix(finding: Finding): string {
  return loosenedByFacts(finding) ? `[loosened by ${FACTS_MARKER}] ` : '';
}

function factsNote(finding: Finding): string {
  const notes: string[] = [];
  if (isLocalVendor(finding)) {
    notes.push(`Vendor entry from ${FACTS_MARKER}, not the knowledge base.`);
  }
  const baseline = baselineText(finding);
  if (baseline) notes.push(`Rule ${baseline}.`);
  else if (finding.transfer?.repositoryFacts?.length) notes.push(`Depends on ${FACTS_MARKER}.`);
  return notes.length > 0 ? ` ${notes.join(' ')}` : '';
}

function buildMessage(finding: Finding): string {
  const text = buildMessageText(finding, markdownText);
  if (!finding.transfer?.dpaUrl) return text;
  const label = isLocalVendor(finding) ? 'DPA, as supplied by this repository' : 'DPA';
  return `${text} [${label}](${markdownUrl(finding.transfer.dpaUrl)})`;
}

function toSarifLocation(evidence: Finding['evidence'][number]): unknown {
  return {
    physicalLocation: {
      artifactLocation: { uri: evidence.file, uriBaseId: '%SRCROOT%' },
      region: {
        startLine: evidence.startLine,
        startColumn: evidence.startColumn,
        endLine: evidence.endLine,
        endColumn: evidence.endColumn,
        snippet: { text: evidence.snippet },
      },
    },
    properties: { kind: evidence.kind, matchedOn: evidence.matchedOn },
  };
}

const SEVERITY_RANK: Record<Severity, number> = { error: 80, warning: 55, note: 25 };
const CONFIDENCE_BONUS = { high: 20, medium: 10, low: 0 } as const;

function toRank(severity: Severity, confidence: keyof typeof CONFIDENCE_BONUS): number {
  return Math.min(100, SEVERITY_RANK[severity] + CONFIDENCE_BONUS[confidence]);
}

/**
 * Deliberately NOT emitted: `security-severity`.
 *
 * Setting it would file privacy findings in GitHub's Security tab dressed as
 * vulnerabilities. A US data transfer is not a CVE, and presenting it as one
 * would be the same category error the claims policy exists to prevent.
 */
