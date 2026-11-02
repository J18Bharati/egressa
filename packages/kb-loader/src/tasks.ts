/**
 * Verification tasks: the legal facts a knowledge base entry carries that a
 * person or agent should re-check against their source, and where to look.
 *
 * Identity data (hosts, packages, regions) is not listed here. It is stable,
 * golden-tested and is what a scan relies on; the legal layer is what goes out
 * of date, so that is what a task names.
 *
 * Every URL in `where` comes from the knowledge base entry itself, never from
 * the scanned repository, so a task cannot point an agent at a page a
 * repository chose.
 */
import { createHash } from 'node:crypto';
import { dpfStatusVerdict } from './dpf-status.js';
import { STALE_AFTER_DAYS } from './staleness.js';
import type { VendorEntry } from './types.js';

export const VERIFY_FACTS = ['dpf', 'dpa', 'subprocessors', 'local-entry'] as const;
export type VerifyFact = (typeof VERIFY_FACTS)[number];

/**
 * Why a task exists. `stale-entry`: the entry is older than the staleness
 * threshold, so every legal fact is listed. `dpf-unknown`: a jurisdiction
 * relies on the DPF decision and the entry has no DPF record.
 * `dpf-status-unobserved`: a record claims certification with no observed list
 * status behind it. `dpf-status-qualified`: the observed status is the
 * qualified one and nobody has accepted it. `dpf-status-unrecognised`: the
 * status is not in the closed table. `unknown-vendor`: a destination matched
 * no entry. `overlay-expired`: a fact the repository recorded has passed its
 * expiry, so the knowledge base's own fact is used until it is read again.
 */
export const VERIFY_REASONS = [
  'stale-entry',
  'dpf-unknown',
  'dpf-status-unobserved',
  'dpf-status-qualified',
  'dpf-status-unrecognised',
  'unknown-vendor',
  'overlay-expired',
] as const;
export type VerifyReason = (typeof VERIFY_REASONS)[number];

export interface VerifyTask {
  /** Deterministic over the vendor, subject, fact, record and reason. */
  id: string;
  /** Null for an unknown vendor, which by definition has no entry. */
  vendorId: string | null;
  fact: VerifyFact;
  reason: VerifyReason;
  /** What the knowledge base says today, and as of when. */
  current: { value: string | null; asOf: string | null; url: string | null };
  /** Pages to check, from knowledge base data only. Empty when there is none. */
  where: string[];
  /** For an unknown vendor, the host or package it was seen as. */
  subject?: string;
}

/** Inputs the entry alone cannot answer. */
export interface VendorTaskContext {
  asOf: Date;
  stale: boolean;
  /** Whether any of the entry's jurisdictions relies on an in-force DPF decision. */
  dpfJurisdiction: boolean;
}

export function verifyTask(task: Omit<VerifyTask, 'id'>): VerifyTask {
  const key = [
    task.vendorId ?? '',
    task.subject ?? '',
    task.fact,
    task.reason,
    task.current.url ?? '',
  ].join('\0');
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 16), ...task };
}

/**
 * The tasks one entry generates. A fresh entry yields only the records that
 * are themselves in doubt; a stale one yields every legal fact it carries that
 * has not itself been re-checked within the threshold, each under its most
 * specific reason. A record re-read last week is not stale because the rest of
 * its entry is.
 */
export function vendorTasks(entry: VendorEntry, context: VendorTaskContext): VerifyTask[] {
  const tasks: VerifyTask[] = [];
  const vendorId = entry.id;
  const dpfRecords = entry.legal.transferMechanisms.filter((m) => m.mechanism === 'DPF');

  for (const m of dpfRecords) {
    const reason =
      dpfRecordReason(m) ??
      (context.stale && !recent(m.lastChecked, context) ? 'stale-entry' : null);
    if (reason === null) continue;
    tasks.push(
      verifyTask({
        vendorId,
        fact: 'dpf',
        reason,
        current: {
          value: m.observedStatus ?? (m.dpfCertified === true ? 'certified' : 'not certified'),
          asOf: m.lastChecked ?? entry.lastVerified,
          url: m.url ?? null,
        },
        where: m.url ? [m.url] : [],
      }),
    );
  }
  if (dpfRecords.length === 0 && context.dpfJurisdiction) {
    tasks.push(
      verifyTask({
        vendorId,
        fact: 'dpf',
        reason: 'dpf-unknown',
        current: { value: null, asOf: entry.lastVerified, url: null },
        // The list itself, not a participant page: there is no record to point at.
        where: ['https://www.dataprivacyframework.gov/list'],
      }),
    );
  }

  if (context.stale && !recent(entry.legal.dpa.lastChecked, context)) {
    const dpa = entry.legal.dpa;
    tasks.push(
      verifyTask({
        vendorId,
        fact: 'dpa',
        reason: 'stale-entry',
        current: {
          value: dpa.available ? (dpa.type ?? 'available') : 'not available',
          asOf: dpa.lastChecked ?? entry.lastVerified,
          url: dpa.url ?? null,
        },
        where: dpa.url ? [dpa.url] : [],
      }),
    );
  }
  if (context.stale) {
    const sub = entry.legal.subprocessors;
    if (sub) {
      tasks.push(
        verifyTask({
          vendorId,
          fact: 'subprocessors',
          reason: 'stale-entry',
          current: { value: sub.listType ?? 'published', asOf: entry.lastVerified, url: sub.url },
          where: [sub.url],
        }),
      );
    }
  }
  return tasks;
}

/** Checked within the staleness threshold of `asOf`. */
function recent(lastChecked: string | undefined, context: VendorTaskContext): boolean {
  if (lastChecked === undefined) return false;
  return Date.parse(lastChecked) >= context.asOf.getTime() - STALE_AFTER_DAYS * 86_400_000;
}

function dpfRecordReason(
  m: VendorEntry['legal']['transferMechanisms'][number],
): VerifyReason | null {
  if (m.observedStatus === undefined) {
    return m.dpfCertified === true ? 'dpf-status-unobserved' : null;
  }
  const verdict = dpfStatusVerdict(m.observedStatus, m.acceptQualifiedStatus !== undefined);
  if (verdict.kind === 'unrecognised') return 'dpf-status-unrecognised';
  // An accepted qualified status is a decision someone owns; re-checking it is
  // the stale-entry cycle's job, not a standing task.
  if (verdict.kind === 'qualified' && m.acceptQualifiedStatus === undefined) {
    return 'dpf-status-qualified';
  }
  return null;
}
