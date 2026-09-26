import { isReferenceOnly } from './output/display.js';
import type { Finding, ScanResult } from './types.js';

/**
 * Token-budgeted view of a scan.
 *
 * A full findings document for a repository with thirty vendors will flood an
 * agent's context, and an agent that runs out of room mid-review is worse than
 * one that asked for more. So the default is a summary plus the strongest N
 * findings with evidence truncated, and an explicit `truncated` flag telling
 * the model that asking for more is possible.
 *
 * This lives in core rather than in the MCP server so the CLI's markdown output
 * and an agent's view can never disagree about what a scan said.
 */
export interface SummaryOptions {
  maxFindings?: number;
  maxEvidencePerFinding?: number;
  /**
   * Where the repository's own configuration was read from, or null when it
   * has none. An agent scanning a repository it does not own needs to know
   * when that repository excluded files or suppressed findings itself.
   */
  config?: string | null;
}

export interface SummarisedFinding {
  ruleId: string;
  vendor: string | null;
  vendorId: string | null;
  jurisdictions: string[];
  euRegion: string;
  severity: string;
  confidence: string;
  exposure: Finding['exposure'];
  evidence: { file: string; line: number; matchedOn: string; kind: string }[];
  evidenceTotal: number;
  /**
   * True when every piece of evidence for this finding is a `reference` --
   * a vendor named in source, never a resolved call site -- computed over the
   * FULL evidence array via `isReferenceOnly()`, before the `evidence` field
   * above is truncated to `maxEvidencePerFinding`. A finding can carry several
   * `dependency` and `reference` entries with the distinguishing signal cut by
   * truncation; this flag survives that cut so a consumer never renders a
   * `reference` as though it were a `callsite`.
   */
  referenceOnly: boolean;
  /** Accepted in the repository's configuration. Kept, never dropped. */
  suppressed: boolean;
  suppression?: { reason: string; expired: boolean; acceptedBy?: string; expires?: string };
  dpaUrl?: string;
  subprocessorsUrl?: string;
  lastVerified?: string;
  disputed?: string;
  remediation: string;
}

export interface SummarisedScan {
  disclaimer: string;
  kb: ScanResult['kb'];
  scan: {
    root: string;
    filesScanned: number;
    manifestsScanned: number;
    degraded: boolean;
    /** Every exclude applied, the configuration's first. */
    exclude?: string[];
    /**
     * The configuration file applied, relative to the root, or null for none.
     * Absent when the caller did not say, which is not the same as none.
     */
    config?: string | null;
  };
  summary: ScanResult['summary'];
  findings: SummarisedFinding[];
  truncated: boolean;
  omittedFindings: number;
  unmatched: ScanResult['unmatched'];
  assumedAdequacyLapsed?: string[];
}

export function summarise(result: ScanResult, options: SummaryOptions = {}): SummarisedScan {
  const maxFindings = options.maxFindings ?? 20;
  const maxEvidence = options.maxEvidencePerFinding ?? 3;
  const shown = result.findings.slice(0, maxFindings);

  return {
    disclaimer: result.disclaimer,
    kb: result.kb,
    scan: {
      root: result.scan.root,
      filesScanned: result.scan.filesScanned,
      manifestsScanned: result.scan.manifestsScanned,
      degraded: result.scan.engine.degraded,
      ...(result.scan.exclude ? { exclude: result.scan.exclude } : {}),
      ...(options.config !== undefined ? { config: options.config } : {}),
    },
    summary: result.summary,
    findings: shown.map((finding) => toSummarised(finding, maxEvidence)),
    truncated: result.findings.length > shown.length,
    omittedFindings: result.findings.length - shown.length,
    unmatched: result.unmatched,
    ...(result.scan.assumedAdequacyLapsed
      ? { assumedAdequacyLapsed: result.scan.assumedAdequacyLapsed }
      : {}),
  };
}

function toSummarised(finding: Finding, maxEvidence: number): SummarisedFinding {
  const eu = finding.transfer?.euRegion;
  return {
    ruleId: finding.ruleId,
    vendor: finding.vendor?.name ?? null,
    vendorId: finding.vendor?.id ?? null,
    jurisdictions: finding.transfer?.jurisdictions ?? [],
    euRegion: !eu
      ? 'unknown'
      : eu.available
        ? `available (${eu.scope ?? 'scope not recorded'})`
        : 'not documented',
    severity: finding.severity,
    confidence: finding.confidence,
    exposure: finding.exposure,
    evidence: finding.evidence.slice(0, maxEvidence).map((e) => ({
      file: e.file,
      line: e.startLine,
      matchedOn: e.matchedOn,
      kind: e.kind,
    })),
    evidenceTotal: finding.evidence.length,
    referenceOnly: isReferenceOnly(finding),
    suppressed: finding.suppressed,
    ...(finding.suppression
      ? {
          suppression: {
            reason: finding.suppression.reason,
            expired: finding.suppression.expired === true,
            ...(finding.suppression.acceptedBy
              ? { acceptedBy: finding.suppression.acceptedBy }
              : {}),
            ...(finding.suppression.expires ? { expires: finding.suppression.expires } : {}),
          },
        }
      : {}),
    ...(finding.transfer?.dpaUrl ? { dpaUrl: finding.transfer.dpaUrl } : {}),
    ...(finding.transfer?.subprocessorsUrl
      ? { subprocessorsUrl: finding.transfer.subprocessorsUrl }
      : {}),
    ...(finding.transfer?.lastVerified ? { lastVerified: finding.transfer.lastVerified } : {}),
    ...(finding.transfer?.disputed ? { disputed: finding.transfer.disputed.summary } : {}),
    remediation: finding.remediation.summary,
  };
}
