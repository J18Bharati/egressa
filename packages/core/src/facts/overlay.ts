/**
 * Applies a repository's checked facts to a copy of the knowledge base.
 *
 * The shipped knowledge base is never modified: every changed vendor is a new
 * object, and the result is rebuilt through `buildKnowledgeBase` so lookups go
 * through the same index code. What a fact may change is closed:
 *
 * - `dpf` replaces the vendor's DPF records, read through the closed status
 *   table, so a status string means the same thing here as in shipped data;
 * - `dpa` and `subprocessors` replace those links;
 * - a local entry adds a vendor the knowledge base does not have.
 *
 * Nothing here can change a shipped vendor's jurisdictions, region map, hosts,
 * packages, name or category, or an adequacy decision. A repository could
 * otherwise attribute its own exfiltration host to an EEA vendor.
 *
 * The trust gate: a fact that would make a vendor DPF certified when the
 * knowledge base says it is not *loosens* a finding, and so does a local entry
 * that would place an unknown host in the EEA or an adequate country. Either
 * applies only when the caller passed `trustFacts`. Without it the fact is reported as
 * `loosening-not-trusted` and the knowledge base's answer stands, so a
 * repository scanned by someone else can make its findings stricter but never
 * clear them.
 */
import {
  type KnowledgeBase,
  type VendorEntry,
  buildKnowledgeBase,
  dpfStatusVerdict,
} from '@egressa/kb';
import { resolveRegion } from '../exposure/regions.js';
import { classifyExposure, vendorIsDpfCertified } from '../exposure/rules.js';
import type { FactEffect, RepositoryFactRef, RuleId } from '../types.js';
import type { CheckedItem, FactsCheck, RepositoryFact } from './load.js';

export type OverlayState =
  | 'applied'
  /** Says what the knowledge base already says; it changed nothing and can be deleted. */
  | 'redundant'
  /** Would clear or soften a finding, and the caller did not pass trustFacts. */
  | 'loosening-not-trusted'
  /** A local entry the shipped knowledge base now covers; the shipped entry is used. */
  | 'superseded'
  | 'expired'
  | 'rejected';

export interface OverlayItem extends Omit<CheckedItem, 'state'> {
  state: OverlayState;
  effect?: FactEffect;
}

export interface Overlay {
  /** The knowledge base with every applied fact in it. */
  kb: KnowledgeBase;
  /** The knowledge base as shipped, for the baseline rule. */
  baseline: KnowledgeBase;
  source: string;
  trusted: boolean;
  items: OverlayItem[];
  /** Applied facts per vendor id, as provenance for findings. */
  byVendor: Map<string, RepositoryFactRef[]>;
  /** Expired facts per vendor id, which become verification tasks. */
  expiredByVendor: Map<string, OverlayItem[]>;
  localIds: ReadonlySet<string>;
}

export function applyOverlay(
  baseline: KnowledgeBase,
  checked: FactsCheck,
  options: { trustFacts: boolean },
): Overlay {
  const { trustFacts } = options;
  const items: OverlayItem[] = [];
  const byVendor = new Map<string, RepositoryFactRef[]>();
  const expiredByVendor = new Map<string, OverlayItem[]>();
  const changed = new Map<string, VendorEntry>();
  const localIds = new Set<string>();
  const add = <V>(map: Map<string, V[]>, key: string, value: V) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  for (const item of checked.items) {
    if (item.kind !== 'local-entry') continue;
    if (item.state !== 'current' || !item.local) {
      items.push({ ...item, state: item.state === 'current' ? 'rejected' : item.state });
      continue;
    }
    const entry = item.local.entry;
    // A local entry cannot certify itself: only a `dpf` fact, which has to
    // cite the DPF list, can. Its own claim is kept as a record and read false.
    const local: VendorEntry = {
      ...entry,
      legal: {
        ...entry.legal,
        transferMechanisms: entry.legal.transferMechanisms.map((m) =>
          m.mechanism === 'DPF' ? { ...m, dpfCertified: false } : m,
        ),
      },
    };
    // Without the entry, its destination is an unknown vendor: a reviewer has
    // to look. An entry that says the data stays in the EEA, or goes only to an
    // adequate country, tells them they need not -- so it loosens, and is held
    // to the same gate as a dpf fact. One naming a third country does not.
    const effect: FactEffect = mostFavourableRule(local, baseline) ? 'loosens' : 'tightens';
    if (effect === 'loosens' && !trustFacts) {
      items.push({ ...item, state: 'loosening-not-trusted', effect });
      continue;
    }
    changed.set(local.id, local);
    localIds.add(local.id);
    add(byVendor, local.id, {
      fact: 'local-entry',
      file: checked.source,
      at: item.at,
      retrievedAt: item.local.retrievedAt,
      verifiedBy: item.local.verifiedBy,
      expiresOn: item.expiresOn ?? '',
      effect,
    });
    items.push({ ...item, state: 'applied', effect });
  }

  for (const item of checked.items) {
    if (item.kind === 'local-entry') continue;
    if (item.state === 'expired' && item.fact) {
      const expired = { ...item, state: 'expired' as const };
      add(expiredByVendor, item.fact.vendor, expired);
      items.push(expired);
      continue;
    }
    if (item.state !== 'current' || !item.fact) {
      items.push({ ...item, state: item.state === 'current' ? 'rejected' : item.state });
      continue;
    }
    const fact = item.fact;
    const before = changed.get(fact.vendor) ?? baseline.byId.get(fact.vendor);
    if (!before) {
      items.push({ ...item, state: 'rejected', reason: 'names a vendor that is not loaded' });
      continue;
    }
    const after = withFact(before, fact);
    // Redundant only when the knowledge base says the same thing at least as
    // recently. A fact that re-confirms an old record is what answers its
    // stale task, so it applies, and deleting it would reopen the task.
    if (sameLegal(before, after) && !fresher(before, fact)) {
      items.push({ ...item, state: 'redundant', effect: 'neutral' });
      continue;
    }
    const effect = effectOf(before, after);
    if (effect === 'loosens' && !trustFacts) {
      items.push({ ...item, state: 'loosening-not-trusted', effect });
      continue;
    }
    changed.set(fact.vendor, after);
    add(byVendor, fact.vendor, {
      fact: fact.fact,
      file: checked.source,
      at: item.at,
      sourceUrl: fact.source.url,
      retrievedAt: fact.source.retrievedAt,
      verifiedBy: fact.verifiedBy,
      expiresOn: item.expiresOn ?? '',
      effect,
      ...(fact.fact === 'dpf' ? { observedStatus: fact.value.observedStatus } : {}),
      ...(fact.fact !== 'dpf' && fact.value.url ? { suppliedUrl: fact.value.url } : {}),
    });
    items.push({ ...item, state: 'applied', effect });
  }

  const order = new Map(checked.items.map((item, i) => [item.at, i]));
  items.sort((a, b) => (order.get(a.at) ?? 0) - (order.get(b.at) ?? 0));

  const vendors = [
    ...baseline.vendors.map((v) => changed.get(v.id) ?? v),
    ...[...changed.values()].filter((v) => localIds.has(v.id)),
  ];
  const kb =
    changed.size === 0
      ? baseline
      : buildKnowledgeBase({
          version: baseline.version,
          vendors,
          adequacy: baseline.adequacy,
          assumeAdequacyLapsed: baseline.assumeAdequacyLapsed,
        });
  return {
    kb,
    baseline,
    source: checked.source,
    trusted: trustFacts,
    items,
    byVendor,
    expiredByVendor,
    localIds,
  };
}

/** The vendor with one fact applied. Only legal fields move. */
function withFact(vendor: VendorEntry, fact: RepositoryFact): VendorEntry {
  switch (fact.fact) {
    case 'dpf': {
      const { observedStatus, participantUrl } = fact.value;
      const accepted = fact.acceptQualifiedStatus;
      const record = {
        mechanism: 'DPF' as const,
        dpfCertified: dpfStatusVerdict(observedStatus, accepted !== undefined).certified,
        url: participantUrl,
        lastChecked: fact.source.retrievedAt,
        observedStatus,
        ...(accepted ? { acceptQualifiedStatus: accepted } : {}),
      };
      // An entry such as Meta's has one record per certified organisation.
      // A fact about one participant replaces that participant's record, or
      // sits beside the others when it is a participant the entry does not
      // have. Only `not-listed` speaks for the vendor as a whole, and replaces
      // every record: one organisation's lapse says nothing about another's.
      const wholeVendor = isNotListed(observedStatus);
      const kept = vendor.legal.transferMechanisms.filter(
        (m) => m.mechanism !== 'DPF' || (!wholeVendor && m.url !== participantUrl),
      );
      return { ...vendor, legal: { ...vendor.legal, transferMechanisms: [...kept, record] } };
    }
    case 'dpa':
      return {
        ...vendor,
        legal: {
          ...vendor.legal,
          dpa: {
            ...(vendor.legal.dpa.type ? { type: vendor.legal.dpa.type } : {}),
            available: fact.value.available,
            ...(fact.value.url ? { url: fact.value.url } : {}),
            lastChecked: fact.source.retrievedAt,
          },
        },
      };
    case 'subprocessors':
      return {
        ...vendor,
        legal: {
          ...vendor.legal,
          subprocessors: {
            ...vendor.legal.subprocessors,
            url: fact.value.url,
            lastChecked: fact.source.retrievedAt,
          },
        },
      };
  }
}

/**
 * Whether a fact changes anything the scan reads. The date it was checked is
 * not one of them: a fact that only re-confirms the knowledge base is
 * redundant, and `facts check` says it can be deleted.
 */
function sameLegal(a: VendorEntry, b: VendorEntry): boolean {
  // Status compared as the table compares it, so a change of case is not a change.
  const strip = (v: VendorEntry) =>
    canonical({
      dpa: { ...v.legal.dpa, lastChecked: undefined },
      sub: v.legal.subprocessors?.url,
      mechanisms: v.legal.transferMechanisms
        .map((m) =>
          canonical({
            ...m,
            lastChecked: undefined,
            observedStatus: m.observedStatus?.trim().replace(/\s+/g, ' ').toLowerCase(),
          }),
        )
        .sort(),
    });
  return strip(a) === strip(b);
}

/** Whether the fact was read later than the record it re-confirms was last checked. */
function fresher(vendor: VendorEntry, fact: RepositoryFact): boolean {
  const { legal } = vendor;
  const checked =
    fact.fact === 'dpf'
      ? legal.transferMechanisms.find(
          (m) => m.mechanism === 'DPF' && m.url === fact.value.participantUrl,
        )?.lastChecked
      : fact.fact === 'dpa'
        ? legal.dpa.lastChecked
        : legal.subprocessors?.lastChecked;
  return checked === undefined || fact.source.retrievedAt > checked;
}

/** JSON with keys in sorted order and undefined members dropped, so field order cannot matter. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => x.localeCompare(y));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Whether a local entry can classify a destination as adequate or EEA-only,
 * with no region or with any region its own map names. The most favourable
 * reading is the one a repository would choose, so it is the one gated.
 */
function mostFavourableRule(entry: VendorEntry, kb: KnowledgeBase): boolean {
  const regions = [null, ...(entry.regions ?? []).map((r) => resolveRegion(entry, r.code))];
  return regions.some((region) => LOOSE_RULES.has(classifyExposure(entry, kb, { region }).ruleId));
}

const LOOSE_RULES = new Set<RuleId>(['transfer/adequate-country-egress', 'transfer/eu-processing']);

function isNotListed(status: string): boolean {
  return dpfStatusVerdict(status, false).kind === 'not-listed';
}

function effectOf(before: VendorEntry, after: VendorEntry): FactEffect {
  const was = vendorIsDpfCertified(before);
  const now = vendorIsDpfCertified(after);
  if (was === now) return 'neutral';
  return now ? 'loosens' : 'tightens';
}
