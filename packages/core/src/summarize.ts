import { isExpiredNoteFor } from './config/index.js';
import { isReferenceOnly, plainText } from './output/display.js';
import { factsHeadline } from './output/provenance.js';
import type { FactsSummary, Finding, RepositoryFactRef, ScanResult, VerifyTask } from './types.js';

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
}

/** Errors beyond this many are counted in `omittedErrors`, not listed. */
const MAX_ERRORS = 20;

/** Verification tasks listed per finding; `verificationTotal` counts them all. */
const MAX_TASKS = 5;

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
  /**
   * `local` when the vendor entry came from the repository's facts file. Its
   * `dpaUrl`, `subprocessorsUrl` and `lastVerified` are then the repository's
   * own, not knowledge base data.
   */
  vendorOrigin?: 'local';
  /** Facts from `.egressa/facts.json` this finding was computed from. */
  repositoryFacts?: RepositoryFactRef[];
  /** The rule before repository facts changed it. */
  baselineRuleId?: string;
  /** What to re-check, and where; at most five, `verificationTotal` counts all. */
  verification?: VerifyTask[];
  verificationTotal?: number;
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
     * An agent scanning a repository it does not own needs to know when that
     * repository excluded files or suppressed findings itself.
     */
    config: string | null;
  };
  summary: ScanResult['summary'];
  findings: SummarisedFinding[];
  truncated: boolean;
  omittedFindings: number;
  unmatched: ScanResult['unmatched'];
  /**
   * The scan's errors, fatal ones first, at most twenty; `omittedErrors`
   * counts the rest. A fatal error is why a summary is empty, and without it a
   * mistyped path read as a clean scan.
   */
  errors: ScanResult['errors'];
  omittedErrors: number;
  assumedAdequacyLapsed?: string[];
  /** What the repository's facts file did to this scan, with a sentence saying so. */
  facts?: FactsSummary & { headline: string };
}

export function summarise(result: ScanResult, options: SummaryOptions = {}): SummarisedScan {
  const maxFindings = options.maxFindings ?? 20;
  const maxEvidence = options.maxEvidencePerFinding ?? 3;
  // An expired suppression's note follows its finding. A cut between the two
  // would keep the reactivated finding and drop the reminder to revisit it, so
  // the note comes along even past the limit.
  const last = result.findings[maxFindings - 1];
  const next = result.findings[maxFindings];
  const keep = last && next && isExpiredNoteFor(next, last) ? maxFindings + 1 : maxFindings;
  const shown = result.findings.slice(0, keep);

  return {
    disclaimer: result.disclaimer,
    kb: result.kb,
    scan: {
      root: result.scan.root,
      filesScanned: result.scan.filesScanned,
      manifestsScanned: result.scan.manifestsScanned,
      degraded: result.scan.engine.degraded,
      ...(result.scan.exclude ? { exclude: result.scan.exclude } : {}),
      config: result.scan.config ?? null,
    },
    summary: result.summary,
    findings: shown.map((finding) => toSummarised(finding, maxEvidence)),
    truncated: result.findings.length > shown.length,
    omittedFindings: result.findings.length - shown.length,
    unmatched: result.unmatched,
    errors: [...result.errors]
      .sort((a, b) => Number(b.fatal) - Number(a.fatal))
      .slice(0, MAX_ERRORS),
    omittedErrors: Math.max(0, result.errors.length - MAX_ERRORS),
    ...(result.scan.assumedAdequacyLapsed
      ? { assumedAdequacyLapsed: result.scan.assumedAdequacyLapsed }
      : {}),
    ...(result.facts
      ? { facts: { ...result.facts, headline: factsHeadline(result.facts, plainText) } }
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
    ...(finding.vendor?.origin ? { vendorOrigin: finding.vendor.origin } : {}),
    ...(finding.transfer?.repositoryFacts
      ? { repositoryFacts: finding.transfer.repositoryFacts }
      : {}),
    ...(finding.baselineRuleId ? { baselineRuleId: finding.baselineRuleId } : {}),
    ...(finding.verification?.length
      ? {
          verification: finding.verification.slice(0, MAX_TASKS),
          verificationTotal: finding.verification.length,
        }
      : {}),
  };
}
