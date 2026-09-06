import { type KnowledgeBase, loadKnowledgeBase } from '@adequacy/kb';
import { DISCLAIMER } from './claims.js';
import { walk } from './discovery/walk.js';
import { analyzeManifests } from './manifests/index.js';
import { confidenceForDependency } from './merge/confidence.js';
import { mergeSignals } from './merge/index.js';
import { FINDINGS_SCHEMA_VERSION } from './types.js';
import type {
  Confidence,
  Finding,
  ScanError,
  ScanResult,
  ScanSummary,
  Severity,
  Signal,
} from './types.js';

export interface ScanOptions {
  root: string;
  toolVersion: string;
  kbPath?: string;
  kb?: KnowledgeBase;
  exclude?: string[];
  includeTransitive?: boolean;
  includeDev?: boolean;
  /** Off until the call-site analyzer lands; manifests alone are still useful. */
  includeCallsites?: boolean;
  includeManifests?: boolean;
  minConfidence?: Confidence;
  onlyVendor?: string[];
  assumeAdequacyLapsed?: string[];
  /** Fixed clock, so snapshot tests are stable. */
  now?: Date;
}

/**
 * The engine's whole public surface. Pure with respect to the outside world:
 * no console, no network, no process.exit. The CLI, the MCP server and the
 * skill are all consumers of this one function's return value.
 */
export function scan(options: ScanOptions): ScanResult {
  const {
    root,
    toolVersion,
    includeTransitive = false,
    includeDev = true,
    includeManifests = true,
    includeCallsites = false,
    minConfidence = 'low',
    onlyVendor,
    now = new Date(),
  } = options;

  const startedAt = now;
  const started = Date.now();

  const kb =
    options.kb ??
    loadKnowledgeBase({
      ...(options.kbPath ? { kbPath: options.kbPath } : {}),
      ...(options.assumeAdequacyLapsed
        ? { assumeAdequacyLapsed: options.assumeAdequacyLapsed }
        : {}),
    });

  const errors: ScanError[] = [];
  const signals: Signal[] = [];
  const unmatchedPackages = new Set<string>();
  const unmatchedHosts = new Set<string>();

  const { manifests, sources } = walk({
    root,
    ...(options.exclude ? { exclude: options.exclude } : {}),
  });

  let manifestsScanned = 0;
  if (includeManifests) {
    const analysis = analyzeManifests({
      root,
      manifestPaths: manifests,
      includeTransitive,
      includeDev,
    });
    manifestsScanned = analysis.manifestsScanned;
    errors.push(...analysis.errors);

    for (const record of analysis.dependencies) {
      const match = kb.lookupPackage(record.ecosystem, record.name);
      if (!match) {
        // Only declared packages are worth reporting as coverage gaps; the
        // transitive tail is noise, not a signal about what to add to the KB.
        if (record.direct) unmatchedPackages.add(record.name);
        continue;
      }
      // A knowledge base entry can opt in to being detected transitively, for
      // cases like a framework integration pulling in a vendor SDK.
      if (!record.direct && match.alias.detectTransitive !== true) continue;

      signals.push({
        kind: 'dependency',
        vendorId: match.vendor.id,
        matchedOn: record.name,
        confidence: confidenceForDependency(record, match.alias),
        location: record.loc,
        snippet: record.snippet,
        ...(record.dev ? { devOnly: true } : {}),
        ...(record.transitiveVia ? { transitiveVia: record.transitiveVia } : {}),
      });
    }
  }

  // Call-site analysis is wired here once the analyzer lands; the shape of the
  // signal it produces is already fixed by the Signal type.
  const engine = includeCallsites
    ? ({ callsite: 'oxc', degraded: false } as const)
    : ({ callsite: 'disabled', degraded: false } as const);

  const filtered = signals.filter((signal) => {
    if (onlyVendor && (!signal.vendorId || !onlyVendor.includes(signal.vendorId))) return false;
    return meetsConfidence(signal.confidence, minConfidence);
  });

  const staleVendorIds = new Set(kb.staleEntries(now).map((v) => v.id));
  const findings = mergeSignals(filtered, { kb, staleVendorIds });

  return {
    $schema: `https://adequacy.dev/schemas/findings-${FINDINGS_SCHEMA_VERSION}.json`,
    schemaVersion: FINDINGS_SCHEMA_VERSION,
    disclaimer: DISCLAIMER,
    tool: { name: 'adequacy', version: toolVersion },
    kb: {
      version: kb.version,
      entryCount: kb.vendors.length,
      license: 'CC-BY-4.0',
      adequacyStatusAsOf: kb.adequacy.asOf,
      staleEntryCount: staleVendorIds.size,
    },
    scan: {
      root,
      startedAt: startedAt.toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      filesScanned: sources.length,
      manifestsScanned,
      engine,
      ...(options.assumeAdequacyLapsed?.length
        ? { assumedAdequacyLapsed: options.assumeAdequacyLapsed }
        : {}),
    },
    summary: summarise(findings),
    findings,
    unmatched: {
      hosts: [...unmatchedHosts].sort(),
      packages: [...unmatchedPackages].sort(),
    },
    errors,
  };
}

const ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
function meetsConfidence(value: Confidence, floor: Confidence): boolean {
  return ORDER[value] >= ORDER[floor];
}

function summarise(findings: Finding[]): ScanSummary {
  const byRule: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, note: 0 };
  const byConfidence: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  const vendors = new Set<string>();

  for (const finding of findings) {
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
    bySeverity[finding.severity] += 1;
    byConfidence[finding.confidence] += 1;
    if (finding.vendor) vendors.add(finding.vendor.id);
  }

  return {
    vendorCount: vendors.size,
    findingCount: findings.length,
    byRule,
    bySeverity,
    byConfidence,
    unresolvedEgress: findings.filter((f) => f.ruleId === 'transfer/unresolved-egress').length,
    suppressed: findings.filter((f) => f.suppressed).length,
  };
}
