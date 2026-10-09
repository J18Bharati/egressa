import { statSync } from 'node:fs';
import { join } from 'node:path';
import { type KnowledgeBase, loadKnowledgeBase } from '@egressa/kb';
import { analyzeFile, parserAvailable } from './callsites/index.js';
import { vendorConstructorSinks } from './callsites/sinks.js';
import { DISCLAIMER } from './claims.js';
import { type EgressaConfig, applySuppressions, suppressionProblems } from './config/index.js';
import { readErrorMessage, readInsideRoot } from './discovery/read-inside.js';
import { excludeProblem, walk } from './discovery/walk.js';
import { analyzeInfrastructure } from './infrastructure/index.js';
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
  /**
   * The repository's `.egressa.yml`, already loaded by `loadConfig`. Its
   * excludes are added to `exclude`, its `includeTransitive` applies unless
   * the option is given, and its suppressions mark findings. Loading stays with
   * the caller so each surface reports a bad file in its own way.
   */
  config?: EgressaConfig;
  includeTransitive?: boolean;
  includeDev?: boolean;
  /** Off until the call-site analyzer lands; manifests alone are still useful. */
  includeCallsites?: boolean;
  /** Read deployment configuration for the regions this repository declares. */
  includeInfrastructure?: boolean;
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
/** Whether `root` is a directory this process can stat. */
function isReadableDirectory(root: string): boolean {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
}

export function scan(options: ScanOptions): ScanResult {
  const {
    root,
    toolVersion,
    config = {},
    includeDev = true,
    includeManifests = true,
    includeCallsites = false,
    includeInfrastructure = true,
    minConfidence = 'low',
    onlyVendor,
    now = new Date(),
  } = options;

  // Config first, then the caller's, matching what `scan.exclude` records.
  const exclude = [...(config.exclude ?? []), ...(options.exclude ?? [])];
  const includeTransitive = options.includeTransitive ?? config.includeTransitive === true;

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

  // A root that is not a readable directory must not read as a clean scan. A
  // typo'd path would otherwise produce zero findings, an empty error list and
  // the same output as a repository with nothing to report.
  const excludeError = excludeProblem(exclude);
  if (excludeError) throw new TypeError(excludeError);

  const rootUsable = isReadableDirectory(root);
  if (!rootUsable) {
    errors.push({
      file: root,
      message: 'not a readable directory; nothing was scanned',
      fatal: true,
    });
  }

  const { manifests, sources, infrastructure } = rootUsable
    ? walk({
        root,
        ...(exclude.length > 0 ? { exclude } : {}),
      })
    : { manifests: [], sources: [], infrastructure: [] };

  // Vendor SDK initialisers, built from the knowledge base rather than a
  // hardcoded table: `aliases.clientConstructors` names the option carrying the
  // destination, which is where a configured region actually appears.
  const vendorSinks = vendorConstructorSinks(
    kb.vendors.map((v) => ({
      vendorId: v.id,
      constructors: v.aliases.clientConstructors ?? [],
    })),
  );

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

  // Degraded means the user asked for call-site analysis and the native parser
  // could not be loaded. The scan still runs on manifests, and says so.
  const degraded = includeCallsites && !parserAvailable();
  let filesAnalysed = 0;
  if (includeCallsites && !degraded) {
    for (const file of sources) {
      let text: string;
      try {
        text = readInsideRoot(root, file);
      } catch (error) {
        errors.push({ file, message: `unreadable: ${readErrorMessage(error)}`, fatal: false });
        continue;
      }

      const { hits, error } = analyzeFile(text, file, vendorSinks);
      if (error) {
        errors.push({ file, message: `${error}; file skipped`, fatal: false });
        continue;
      }
      filesAnalysed += 1;

      for (const hit of hits) {
        if (hit.host === null) {
          // A hit the sink itself attributed -- `new S3Client({ region })`
          // names a vendor and a jurisdiction without naming a host. Not an
          // unresolved destination: nothing about it is unknown.
          if (hit.vendorId) {
            signals.push({
              kind: hit.kind,
              vendorId: hit.vendorId,
              matchedOn: hit.matchedOn,
              confidence: hit.confidence,
              location: hit.location,
              snippet: hit.snippet,
              ...(hit.region ? { region: hit.region } : {}),
            });
            continue;
          }
          // Destination unknown. Reported so a human can check the deployment
          // configuration; never attributed to a vendor.
          signals.push({
            kind: hit.kind,
            vendorId: null,
            matchedOn: hit.matchedOn,
            confidence: hit.confidence,
            location: hit.location,
            snippet: hit.snippet,
            ...(hit.unresolvedReason ? { unresolvedReason: hit.unresolvedReason } : {}),
          });
          continue;
        }

        const match = kb.lookupHost(hit.host);
        if (!match) {
          unmatchedHosts.add(hit.host);
        }
        signals.push({
          kind: hit.kind,
          vendorId: hit.vendorId ?? match?.vendor.id ?? null,
          matchedOn: hit.host,
          confidence: hit.confidence,
          location: hit.location,
          snippet: hit.snippet,
          ...(hit.region ? { region: hit.region } : {}),
        });
      }
    }
  }

  // Regions this repository declares for infrastructure it controls. Under
  // EDPB Guidelines 05/2021 the transfer is to the provider as a processor,
  // not to the region, so the provider is the vendor and the region selects
  // which of its jurisdictions applies.
  if (includeInfrastructure) {
    const infra = analyzeInfrastructure({ root, configPaths: infrastructure });
    errors.push(...infra.errors);
    for (const record of infra.regions) {
      const vendor = kb.byId.get(record.provider);
      if (!vendor) unmatchedHosts.add(record.provider);
      signals.push({
        kind: 'infrastructure',
        vendorId: vendor?.id ?? null,
        matchedOn: record.region,
        confidence: 'high',
        location: record.loc,
        snippet: record.snippet,
        region: record.region,
      });
    }
  }

  const engine = includeCallsites
    ? ({ callsite: degraded ? 'unavailable' : 'oxc', degraded } as const)
    : ({ callsite: 'disabled', degraded: false } as const);

  const filtered = signals.filter((signal) => {
    if (onlyVendor && (!signal.vendorId || !onlyVendor.includes(signal.vendorId))) return false;
    return meetsConfidence(signal.confidence, minConfidence);
  });

  const staleVendorIds = new Set(kb.staleEntries(now).map((v) => v.id));
  const merged = mergeSignals(filtered, { kb, staleVendorIds });
  const narrowedBy = [
    ...(onlyVendor ? ['only some vendors were scanned'] : []),
    ...(minConfidence !== 'low' ? [`findings below ${minConfidence} confidence were dropped`] : []),
    ...(includeDev ? [] : ['dev dependencies were skipped']),
    ...(includeManifests ? [] : ['manifests were not read']),
    // The caller's excludes only: the config's own are part of what the team
    // committed, and a suppression that relies on an excluded tree is stale.
    ...(options.exclude?.length ? ['the caller excluded paths'] : []),
    // A what-if run rewrites rule ids, so a rule suppression can stop matching.
    ...(options.assumeAdequacyLapsed?.length ? ['adequacy decisions were assumed withdrawn'] : []),
    // The config asked for transitive dependencies and the caller turned them off.
    ...(!includeTransitive && config.includeTransitive === true
      ? ['transitive dependencies were left out']
      : []),
    ...(!includeCallsites
      ? ['call sites were not analysed']
      : degraded
        ? ['call sites could not be analysed']
        : []),
  ];
  for (const message of suppressionProblems(merged, config, new Set(kb.byId.keys()), narrowedBy)) {
    errors.push({ file: config.source ?? '.egressa.yml', message, fatal: false });
  }
  const findings = applySuppressions(merged, config, now);

  return {
    $schema: `https://egressa.dev/schemas/findings-${FINDINGS_SCHEMA_VERSION}.json`,
    schemaVersion: FINDINGS_SCHEMA_VERSION,
    disclaimer: DISCLAIMER,
    tool: { name: 'egressa', version: toolVersion },
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
      filesScanned: includeCallsites ? filesAnalysed : sources.length,
      manifestsScanned,
      engine,
      ...(options.assumeAdequacyLapsed?.length
        ? { assumedAdequacyLapsed: options.assumeAdequacyLapsed }
        : {}),
      // The merged list actually handed to walk(), config first, so the
      // document records what was applied rather than what either source
      // asked for on its own.
      ...(exclude.length > 0 ? { exclude } : {}),
      config: config.source ?? null,
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
