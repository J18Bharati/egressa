import { createHash } from 'node:crypto';
import { type KnowledgeBase, type VendorEntry, verifyTask } from '@egressa/kb';
import { type AppliedRegion, isUnmappedRegion, resolveRegion } from '../exposure/regions.js';
import { type ExposureResult, classifyExposure } from '../exposure/rules.js';
import type { Overlay } from '../facts/overlay.js';
import { RULES } from '../rules.js';
import type {
  Confidence,
  Evidence,
  Finding,
  Remediation,
  RuleId,
  Signal,
  TransferFacts,
  VerifyTask,
} from '../types.js';
import { strongest } from './confidence.js';

export interface MergeOptions {
  kb: KnowledgeBase;
  /** The repository's applied facts, when it has any; `kb` already carries them. */
  overlay?: Overlay;
  /**
   * The instant staleness and verification tasks are judged against. Required,
   * so the same signals always merge to the same findings: a default of "now"
   * made the output depend on the day a test happened to run.
   */
  now: Date;
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
  const { kb, now, overlay } = options;
  const staleVendorIds = new Set(kb.staleEntries(now).map((v) => v.id));
  const groups = new Map<
    string,
    {
      ruleId: RuleId;
      vendor: VendorEntry | null;
      signals: Signal[];
      classified: ExposureResult | null;
      region: AppliedRegion | null;
    }
  >();

  for (const signal of signals) {
    const vendor = signal.vendorId ? (kb.byId.get(signal.vendorId) ?? null) : null;
    // Classify once, here, and carry the result into the finding. This used to
    // run per signal for the rule id and again per group for the exposure,
    // which agreed only because both were a pure function of the vendor. A
    // region makes them disagree -- a finding whose rule came from one region
    // and whose flags came from another, with nothing in the output to show it.
    // buildFinding re-classifies only to add unmapped regions to the audit
    // trail, with this same resolved region, so the rule and flags cannot move.
    const region = vendor && signal.region ? resolveRegion(vendor, signal.region) : null;
    // An unmapped region cannot change the rule or the narrowing, so it is left
    // out here and added once the whole group is known (see buildFinding).
    const classified = vendor ? classifyExposure(vendor, kb, { region }) : null;
    const ruleId = classified?.ruleId ?? unmatchedRule(signal);

    // Only a region that actually narrowed splits a group. An unmapped code
    // narrows nothing, so it must not fragment findings either.
    const narrowedTo = classified?.exposure.inputs.some((i) => i.startsWith('narrowedTo:'))
      ? region?.country
      : undefined;
    const key = `${signal.vendorId ?? `unknown:${signal.matchedOn}`}|${ruleId}|${narrowedTo ?? ''}`;

    const existing = groups.get(key);
    if (existing) existing.signals.push(signal);
    else groups.set(key, { ruleId, vendor, signals: [signal], classified, region: region ?? null });
  }

  const findings: Finding[] = [];
  for (const group of groups.values()) {
    findings.push(
      buildFinding(
        group.ruleId,
        group.vendor,
        group.signals,
        group.classified,
        group.region,
        kb,
        overlay,
      ),
    );
  }

  // Deterministic order: severity, then confidence, then vendor name.
  findings.sort(
    (a, b) =>
      severityOrder(b) - severityOrder(a) ||
      confidenceOrder(b) - confidenceOrder(a) ||
      (a.vendor?.name ?? a.ruleId).localeCompare(b.vendor?.name ?? b.ruleId),
  );
  return withVerification(findings, kb, now, staleVendorIds, overlay);
}

/**
 * Attaches verification tasks, and one `kb/stale-entry` note per stale vendor.
 *
 * The note sits directly after that vendor's first finding, for the reason the
 * expired-suppression note does: a summarised view keeps the first N findings,
 * and a note placed last is the first thing cut. A stale vendor's tasks go on
 * the note only, so the same task is never listed twice.
 */
function withVerification(
  findings: Finding[],
  kb: KnowledgeBase,
  now: Date,
  staleVendorIds: Set<string>,
  overlay: Overlay | undefined,
): Finding[] {
  const noted = new Set<string>();
  return findings.flatMap((finding) => {
    const vendor = finding.vendor ? kb.byId.get(finding.vendor.id) : undefined;
    if (!vendor) {
      if (finding.ruleId !== 'transfer/unknown-vendor-egress') return [finding];
      const subject = finding.evidence[0]?.matchedOn ?? '';
      const task = verifyTask({
        vendorId: null,
        subject,
        fact: 'local-entry',
        reason: 'unknown-vendor',
        current: { value: null, asOf: null, url: null },
        where: [],
      });
      return [{ ...finding, verification: [task] }];
    }
    const tasks = [...kb.verifyTasks(vendor, now), ...expiredFactTasks(vendor, overlay)];
    if (!staleVendorIds.has(vendor.id)) {
      return [tasks.length > 0 ? { ...finding, verification: tasks } : finding];
    }
    if (noted.has(vendor.id)) return [finding];
    noted.add(vendor.id);
    return [finding, staleNote(finding, vendor, tasks)];
  });
}

/**
 * A repository fact that expired is a task to read its source again. The task
 * points at the knowledge base's own page for that fact, never at the URL the
 * expired fact cited, so a task's `where` stays knowledge base data.
 */
function expiredFactTasks(vendor: VendorEntry, overlay: Overlay | undefined): VerifyTask[] {
  return (overlay?.expiredByVendor.get(vendor.id) ?? []).flatMap((item) => {
    const kind = item.fact?.fact;
    if (!kind) return [];
    const dpf = vendor.legal.transferMechanisms.find((m) => m.mechanism === 'DPF');
    const url =
      kind === 'dpf'
        ? (dpf?.url ?? null)
        : kind === 'dpa'
          ? (vendor.legal.dpa.url ?? null)
          : (vendor.legal.subprocessors?.url ?? null);
    return [
      verifyTask({
        vendorId: vendor.id,
        fact: kind,
        reason: 'overlay-expired',
        current: { value: null, asOf: item.expiresOn ?? null, url },
        where: url ? [url] : kind === 'dpf' ? ['https://www.dataprivacyframework.gov/list'] : [],
      }),
    ];
  });
}

function staleNote(finding: Finding, vendor: VendorEntry, tasks: VerifyTask[]): Finding {
  const primary = finding.evidence[0];
  return {
    ...finding,
    id: fingerprint(vendor.id, 'kb/stale-entry', primary, null),
    ruleId: 'kb/stale-entry',
    exposure: null,
    severity: RULES['kb/stale-entry'].defaultLevel,
    remediation: {
      summary: `The knowledge base entry for ${vendor.name} was last verified on ${vendor.lastVerified}. ${RULES['kb/stale-entry'].help}`,
      links: [...new Set(tasks.flatMap((t) => t.where))].map((url) => ({
        label: `${vendor.name}: source to re-check`,
        url,
      })),
    },
    suppressed: false,
    suppression: null,
    verification: tasks,
  };
}

/** The rule for a signal that matched no knowledge base entry. */
function unmatchedRule(signal: Signal): RuleId {
  return signal.unresolvedReason ? 'transfer/unresolved-egress' : 'transfer/unknown-vendor-egress';
}

function buildFinding(
  ruleId: RuleId,
  vendor: VendorEntry | null,
  signals: Signal[],
  classified: ExposureResult | null,
  region: AppliedRegion | null,
  kb: KnowledgeBase,
  overlay: Overlay | undefined,
): Finding {
  const evidence = signals.map((s) => toEvidence(s, vendor)).sort(byStrength);
  const confidence = strongest(signals.map((s) => s.confidence));
  const primary = evidence[0];

  const applied = vendor ? (overlay?.byVendor.get(vendor.id) ?? []) : [];
  const local = vendor !== null && overlay?.localIds.has(vendor.id) === true;
  const transfer = vendor
    ? { ...toTransferFacts(vendor), ...(applied.length > 0 ? { repositoryFacts: applied } : {}) }
    : null;
  // Re-classified with every unmapped region the group's evidence carries, so
  // the audit trail matches the evidence whatever order the signals arrived in.
  const unmappedRegions = signals.flatMap((s) =>
    s.region !== undefined && isUnmappedRegion(vendor, s.region) ? [s.region] : [],
  );
  const computed =
    vendor && unmappedRegions.length > 0
      ? classifyExposure(vendor, kb, { region, unmappedRegions }).exposure
      : (classified?.exposure ?? null);
  // The audit trail says which inputs came from the repository rather than the
  // knowledge base, so a reader can tell a shipped answer from a supplied one.
  const factInputs = [
    ...(local ? ['factSource:local'] : []),
    ...[...new Set(applied.filter((a) => a.fact !== 'local-entry').map((a) => a.fact))].map(
      (fact) => `factSource:${fact}:overlay`,
    ),
  ];
  const exposure =
    computed && factInputs.length > 0
      ? { ...computed, inputs: [...computed.inputs, ...factInputs] }
      : computed;

  // The rule the shipped knowledge base alone gives, when a fact changed it.
  const shippedVendor =
    vendor && applied.some((a) => a.fact !== 'local-entry')
      ? overlay?.baseline.byId.get(vendor.id)
      : undefined;
  const baselineRule = shippedVendor
    ? classifyExposure(shippedVendor, overlay?.baseline ?? kb, { region }).ruleId
    : undefined;

  return {
    id: fingerprint(
      vendor?.id ?? `unknown:${signals[0]?.matchedOn ?? ''}`,
      ruleId,
      primary,
      exposure?.inputs.some((i) => i.startsWith('narrowedTo:')) ? (region?.country ?? null) : null,
    ),
    ruleId,
    vendor: vendor
      ? {
          id: vendor.id,
          name: vendor.name,
          category: vendor.category,
          ...(local ? { origin: 'local' as const } : {}),
        }
      : null,
    transfer,
    exposure,
    severity: RULES[ruleId].defaultLevel,
    confidence,
    signals,
    evidence,
    remediation: buildRemediation(ruleId, vendor),
    suppressed: false,
    suppression: null,
    ...(baselineRule !== undefined && baselineRule !== ruleId
      ? { baselineRuleId: baselineRule }
      : {}),
  };
}

function toEvidence(signal: Signal, vendor: VendorEntry | null): Evidence {
  return {
    ...signal.location,
    kind: signal.kind,
    matchedOn: signal.matchedOn,
    snippet: signal.snippet,
    confidence: signal.confidence,
    ...(signal.devOnly ? { devOnly: true } : {}),
    ...(signal.transitiveVia ? { transitiveVia: signal.transitiveVia } : {}),
    // This list is a whitelist: a field not named here is dropped from the
    // finding even though the signal carried it.
    ...(signal.region ? { region: signal.region } : {}),
    ...(isUnmappedRegion(vendor, signal.region) ? { regionUnmapped: true as const } : {}),
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
      mechanism: m.mechanism,
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
      publisher: s.publisher,
      accessedAt: s.accessedAt,
    })),
    lastVerified: vendor.lastVerified,
    disputed: vendor.disputed ?? null,
  };
}

function buildRemediation(ruleId: RuleId, vendor: VendorEntry | null): Remediation {
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

  return { summary: RULES[ruleId].help, links };
}

/**
 * Stable across runs and across unrelated edits elsewhere in the file, because
 * SARIF alerts are keyed on it: a fingerprint that moved would close and reopen
 * every alert on every commit.
 */
function fingerprint(
  vendorKey: string,
  ruleId: string,
  primary: Evidence | undefined,
  narrowedCountry: string | null,
): string {
  const parts = [vendorKey, ruleId, primary?.file ?? '', primary?.matchedOn ?? ''];
  // Appended only when a region narrowed the answer. An empty component would
  // still change the digest, because the separator count changes -- so every
  // finding produced before regions existed hashes the identical four-field
  // string and its alert survives the upgrade rather than closing and
  // reopening.
  if (narrowedCountry) parts.push(`region:${narrowedCountry}`);
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

const SEVERITY_ORDER = { error: 3, warning: 2, note: 1 } as const;
const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const severityOrder = (f: Finding) => SEVERITY_ORDER[f.severity];
const confidenceOrder = (f: Finding) => CONFIDENCE_ORDER[f.confidence];
