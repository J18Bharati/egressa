/**
 * The stable contract between the engine and its three consumers (CLI, MCP
 * server, skill). These types are the source of truth; the published schema
 * is generated from them and CI asserts the two agree.
 *
 * Compatibility rule: additive changes bump the minor version, removals or
 * meaning changes bump the major and get a new schema file. Consumers pin
 * `schemaVersion`.
 */

export const FINDINGS_SCHEMA_VERSION = '1.1.0';

export type RuleId =
  | 'transfer/third-country-egress'
  | 'transfer/third-country-egress-eu-region-available'
  | 'transfer/adequate-country-egress'
  | 'transfer/eu-processing'
  | 'transfer/unknown-vendor-egress'
  | 'transfer/unresolved-egress'
  | 'kb/stale-entry'
  | 'config/expired-suppression';

/** SARIF-aligned levels. Nothing defaults to `error`. */
export type Severity = 'error' | 'warning' | 'note';

/**
 * How the signal was obtained -- orthogonal to severity, which comes from KB
 * facts about the vendor. A resolved call site and a transitive dependency can
 * carry identical severity while deserving very different trust.
 */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * What kind of observation produced a signal.
 *
 * `callsite` and `reference` are deliberately distinct, and the distinction is
 * load-bearing:
 *
 * - `callsite` means **data left here**. `fetch`, `axios`, `got`, `ky`,
 *   `$fetch`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, an HTTP
 *   client member call, and a knowledge base `clientConstructors` entry all
 *   open, or configure, a connection to the destination.
 * - `reference` means **a vendor is named here**. It is NOT evidence that a
 *   call happened. `new URL(...)` and `new Request(...)` construct a parsed
 *   object and open no socket: the same expression appears in an HTTPS-redirect
 *   middleware parsing an *inbound* request, and in a database DSN rewritten
 *   only to set a query parameter. The vendor attribution can still be right --
 *   `new URL(`${GMAIL_API_BASE}/messages`)` on the line before a `fetch` names
 *   the right vendor -- which is why these are demoted rather than dropped.
 *
 * Consumers must not render a `reference` as though it were a `callsite`.
 */
export const SIGNAL_KINDS = [
  'dependency',
  'callsite',
  'reference',
  'html-script',
  'infrastructure',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export type Ecosystem = 'npm' | 'pypi';

/** ISO 3166-1 alpha-2, or the pseudo-code `EEA`. */
export type CountryCode = string;

// ---------------------------------------------------------------------------
// Evidence and signals
// ---------------------------------------------------------------------------

export interface SourceLocation {
  /** Repo-relative, POSIX separators, so output is stable across platforms. */
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface Evidence extends SourceLocation {
  kind: SignalKind;
  /** The host or package name that matched a knowledge base alias. */
  matchedOn: string;
  /** Single-line excerpt, trimmed and length-capped. */
  snippet: string;
  confidence: Confidence;
  /** Set when the evidence came from a dev-only dependency. */
  devOnly?: boolean;
  /** Set when the dependency was reached transitively. */
  transitiveVia?: string[];
  /** Region identifier this evidence carried, verbatim. */
  region?: string;
}

export interface Signal {
  kind: SignalKind;
  vendorId: string | null;
  matchedOn: string;
  confidence: Confidence;
  location: SourceLocation;
  snippet: string;
  devOnly?: boolean;
  transitiveVia?: string[];
  /** For unresolved egress: the named but unresolvable source, e.g. `process.env.API_URL`. */
  unresolvedReason?: string;
  /**
   * A region identifier read from configuration, verbatim as written.
   *
   * Resolved against the vendor's own `regions` map, never from its prefix.
   * Carried raw so an unmapped identifier can still be reported rather than
   * silently dropped.
   */
  region?: string;
}

// ---------------------------------------------------------------------------
// Transfer facts (mirrored from the knowledge base, never inferred)
// ---------------------------------------------------------------------------

export type EuRegionScope = 'full' | 'partial' | 'product-specific';

export interface EuRegionInfo {
  available: boolean;
  /** EU regions are usually partial; a boolean here would overstate coverage. */
  scope?: EuRegionScope;
  docUrl?: string;
  notes?: string;
}

export type TransferMechanismKind = 'DPF' | 'SCC' | 'BCR' | 'adequacy' | 'derogation' | 'none';

export interface TransferMechanism {
  mechanism: TransferMechanismKind;
  dpfCertified?: boolean;
  url?: string;
  lastChecked?: string;
}

export interface KbSource {
  url: string;
  title: string;
  publisher: 'vendor' | 'regulator' | 'other';
  accessedAt: string;
}

export interface TransferFacts {
  jurisdictions: CountryCode[];
  euRegion: EuRegionInfo;
  mechanisms: TransferMechanism[];
  dpaUrl?: string;
  subprocessorsUrl?: string;
  dataCategories: string[];
  kbSources: KbSource[];
  lastVerified: string;
  /** Set when a good-faith objection has been raised; surfaced in all output. */
  disputed?: { issueUrl: string; raisedAt: string; summary: string } | null;
}

// ---------------------------------------------------------------------------
// Exposure (computed from facts by a versioned rule table, never authored)
// ---------------------------------------------------------------------------

export type ExposureLevel = 'none' | 'low' | 'moderate' | 'elevated';

export interface Exposure {
  /**
   * Flags are the primary output. A dispute about a flag is settled by a URL.
   *
   * True whenever processing happens outside the EEA, adequate destination or
   * not. Under Art 44 a transfer to an adequate country is still a transfer to
   * a third country; Art 45 is the legal basis *for* it, not a denial that one
   * occurred. Whether anything further is needed is `additionalSafeguardsRequired`.
   */
  thirdCountryTransfer: boolean;
  euAlternativeAvailable: boolean;
  /**
   * True when Chapter V is satisfied for this vendor only by an adequacy
   * decision -- so withdrawing that decision changes this finding. False for a
   * vendor that relies on SCCs, whose position does not move if adequacy lapses.
   */
  adequacyDependent: boolean;
  /**
   * True when the transfer needs a safeguard under Art 46 (SCCs, BCRs) beyond
   * an adequacy decision. False for EEA processing, and false where adequacy
   * covers the destination, because adequacy is itself the Art 45 basis.
   */
  additionalSafeguardsRequired: boolean;
  /** Derived convenience ordinal. Disputes about this are unwinnable; prefer the flags. */
  level: ExposureLevel;
  rulesVersion: string;
  /** The fact tuple the rule table consumed, for auditability. */
  inputs: string[];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface VendorRef {
  id: string;
  name: string;
  category: string;
}

export interface Suppression {
  reason: string;
  acceptedBy?: string;
  expires?: string;
  expired?: boolean;
  source: 'config' | 'inline';
}

export interface RemediationLink {
  label: string;
  url: string;
}

export interface Remediation {
  summary: string;
  links: RemediationLink[];
}

export interface Finding {
  /** Stable fingerprint over vendorId + ruleId + normalized primary location. */
  id: string;
  ruleId: RuleId;
  vendor: VendorRef | null;
  transfer: TransferFacts | null;
  exposure: Exposure | null;
  severity: Severity;
  confidence: Confidence;
  signals: Signal[];
  evidence: Evidence[];
  remediation: Remediation;
  suppressed: boolean;
  suppression: Suppression | null;
}

// ---------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------

export interface ScanError {
  file: string;
  message: string;
  fatal: boolean;
}

export interface ScanSummary {
  vendorCount: number;
  findingCount: number;
  byRule: Record<string, number>;
  bySeverity: Record<Severity, number>;
  byConfidence: Record<Confidence, number>;
  unresolvedEgress: number;
  suppressed: number;
}

export interface EngineInfo {
  callsite: 'oxc' | 'unavailable' | 'disabled';
  /**
   * True when call-site analysis was requested but the native parser could not
   * be loaded on this platform, so only manifest signals were collected.
   * There is no regex fallback: the scan is narrower, and says so rather than
   * pretending the missing analysis produced nothing to find.
   */
  degraded: boolean;
}

export interface ScanMeta {
  root: string;
  startedAt: string;
  durationMs: number;
  filesScanned: number;
  manifestsScanned: number;
  engine: EngineInfo;
  /** Set when --assume-adequacy-lapsed was used, naming the lapsed decisions. */
  assumedAdequacyLapsed?: string[];
}

export interface KbMeta {
  version: string;
  entryCount: number;
  license: 'CC-BY-4.0';
  adequacyStatusAsOf: string;
  staleEntryCount: number;
}

/**
 * Hosts and packages that were detected but matched no knowledge base entry.
 * Without telemetry this block is the only recall signal available, so it is
 * part of the contract rather than a debug aid.
 */
export interface UnmatchedBlock {
  hosts: string[];
  packages: string[];
}

export interface ScanResult {
  $schema?: string;
  schemaVersion: string;
  disclaimer: string;
  tool: { name: 'egressa'; version: string };
  kb: KbMeta;
  scan: ScanMeta;
  summary: ScanSummary;
  findings: Finding[];
  unmatched: UnmatchedBlock;
  errors: ScanError[];
}
