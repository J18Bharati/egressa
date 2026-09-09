import { createHash } from 'node:crypto';
import type { KnowledgeBase, VendorEntry } from '@egressa/kb';
import { classifyExposure } from '../exposure/rules.js';
import { RULES } from '../rules.js';
import type {
  Confidence,
  Evidence,
  Finding,
  Remediation,
  RuleId,
  Signal,
  TransferFacts,
} from '../types.js';
import { strongest } from './confidence.js';

export interface MergeOptions {
  kb: KnowledgeBase;
  /** Entries older than the staleness threshold, so findings can note it. */
  staleVendorIds?: Set<string>;
}

/**
 * Groups signals into findings.
 *
 * One finding per (vendor, rule), carrying every location as evidence -- not
 * one finding per line. A reviewer wants to know "this repository sends data to
 * Mixpanel (US)", not to read forty identical annotations. In SARIF the first
 * evidence becomes the location and the rest become relatedLocations.
 */
export function mergeSignals(signals: Signal[], options: MergeOptions): Finding[] {
  const { kb, staleVendorIds = new Set() } = options;
  const groups = new Map<
    string,
    { ruleId: RuleId; vendor: VendorEntry | null; signals: Signal[] }
  >();

  for (const signal of signals) {
    const vendor = signal.vendorId ? (kb.byId.get(signal.vendorId) ?? null) : null;
    const ruleId = ruleForSignal(signal, vendor, kb);
    const key = `${signal.vendorId ?? `unknown:${signal.matchedOn}`}|${ruleId}`;
    const existing = groups.get(key);
    if (existing) existing.signals.push(signal);
    else groups.set(key, { ruleId, vendor, signals: [signal] });
  }

  const findings: Finding[] = [];
  for (const group of groups.values()) {
    findings.push(buildFinding(group.ruleId, group.vendor, group.signals, kb, staleVendorIds));
  }

  // Deterministic order: severity, then confidence, then vendor name.
  return findings.sort(
    (a, b) =>
      severityOrder(b) - severityOrder(a) ||
      confidenceOrder(b) - confidenceOrder(a) ||
      (a.vendor?.name ?? a.ruleId).localeCompare(b.vendor?.name ?? b.ruleId),
  );
}

function ruleForSignal(signal: Signal, vendor: VendorEntry | null, kb: KnowledgeBase): RuleId {
  if (!vendor) {
    return signal.unresolvedReason
      ? 'transfer/unresolved-egress'
      : 'transfer/unknown-vendor-egress';
  }
  return classifyExposure(vendor, kb).ruleId;
}

function buildFinding(
  ruleId: RuleId,
  vendor: VendorEntry | null,
  signals: Signal[],
  kb: KnowledgeBase,
  staleVendorIds: Set<string>,
): Finding {
  const evidence = signals.map(toEvidence).sort(byStrength);
  const confidence = strongest(signals.map((s) => s.confidence));
  const primary = evidence[0];

  const transfer = vendor ? toTransferFacts(vendor) : null;
  const exposure = vendor ? classifyExposure(vendor, kb).exposure : null;

  return {
    id: fingerprint(vendor?.id ?? `unknown:${signals[0]?.matchedOn ?? ''}`, ruleId, primary),
    ruleId,
    vendor: vendor ? { id: vendor.id, name: vendor.name, category: vendor.category } : null,
    transfer,
    exposure,
    severity: RULES[ruleId].defaultLevel,
    confidence,
    signals,
    evidence,
    remediation: buildRemediation(ruleId, vendor, staleVendorIds),
    suppressed: false,
    suppression: null,
  };
}

function toEvidence(signal: Signal): Evidence {
  return {
    ...signal.location,
    kind: signal.kind,
    matchedOn: signal.matchedOn,
    snippet: signal.snippet,
    confidence: signal.confidence,
    ...(signal.devOnly ? { devOnly: true } : {}),
    ...(signal.transitiveVia ? { transitiveVia: signal.transitiveVia } : {}),
  };
}

/** Strongest evidence first, so the SARIF primary location is the best one. */
function byStrength(a: Evidence, b: Evidence): number {
  const rank = (e: Evidence) =>
    (e.confidence === 'high' ? 4 : e.confidence === 'medium' ? 2 : 0) +
    (e.kind === 'callsite' ? 1 : 0);
  return rank(b) - rank(a) || a.file.localeCompare(b.file) || a.startLine - b.startLine;
}

function toTransferFacts(vendor: VendorEntry): TransferFacts {
  return {
    jurisdictions: vendor.processing.jurisdictions.map((j) => j.country),
    euRegion: vendor.processing.euRegion,
    mechanisms: vendor.legal.transferMechanisms.map((m) => ({
      mechanism: m.mechanism as TransferFacts['mechanisms'][number]['mechanism'],
      ...(m.dpfCertified !== undefined ? { dpfCertified: m.dpfCertified } : {}),
      ...(m.url ? { url: m.url } : {}),
      ...(m.lastChecked ? { lastChecked: m.lastChecked } : {}),
    })),
    ...(vendor.legal.dpa.url ? { dpaUrl: vendor.legal.dpa.url } : {}),
    ...(vendor.legal.subprocessors?.url
      ? { subprocessorsUrl: vendor.legal.subprocessors.url }
      : {}),
    dataCategories: vendor.dataCategories.map((c) => c.category),
    kbSources: vendor.sources.map((s) => ({
      url: s.url,
      title: s.title,
      publisher: s.publisher as TransferFacts['kbSources'][number]['publisher'],
      accessedAt: s.accessedAt,
    })),
    lastVerified: vendor.lastVerified,
    disputed: vendor.disputed ?? null,
  };
}

function buildRemediation(
  ruleId: RuleId,
  vendor: VendorEntry | null,
  staleVendorIds: Set<string>,
): Remediation {
  const links: Remediation['links'] = [];
  if (vendor?.legal.dpa.url) {
    links.push({ label: `${vendor.name} data processing agreement`, url: vendor.legal.dpa.url });
  }
  if (vendor?.legal.subprocessors?.url) {
    links.push({ label: `${vendor.name} sub-processors`, url: vendor.legal.subprocessors.url });
  }
  if (vendor?.processing.euRegion.docUrl) {
    links.push({ label: `${vendor.name} data regions`, url: vendor.processing.euRegion.docUrl });
  }
  if (!vendor) {
    links.push({
      label: 'Request a knowledge base entry',
      url: 'https://github.com/egressa-dev/egressa/issues/new?template=vendor-request.yml',
    });
  }

  const stale = vendor && staleVendorIds.has(vendor.id);
  const summary = stale
    ? `${RULES[ruleId].help} This entry has not been re-verified recently; check the sources before relying on it.`
    : RULES[ruleId].help;

  return { summary, links };
}

/**
 * Stable across runs and across unrelated edits elsewhere in the file, because
 * SARIF alerts are keyed on it: a fingerprint that moved would close and reopen
 * every alert on every commit.
 */
function fingerprint(vendorKey: string, ruleId: string, primary: Evidence | undefined): string {
  const hash = createHash('sha256');
  hash.update(`${vendorKey}\0${ruleId}\0${primary?.file ?? ''}\0${primary?.matchedOn ?? ''}`);
  return hash.digest('hex').slice(0, 16);
}

const SEVERITY_ORDER = { error: 3, warning: 2, note: 1 } as const;
const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const severityOrder = (f: Finding) => SEVERITY_ORDER[f.severity];
const confidenceOrder = (f: Finding) => CONFIDENCE_ORDER[f.confidence];
