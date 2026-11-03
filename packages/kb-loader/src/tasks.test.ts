import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STALE_AFTER_DAYS,
  type VendorEntry,
  knowledgeBaseTasks,
  loadKnowledgeBase,
} from './index.js';
import { vendorTasks } from './tasks.js';

const kb = loadKnowledgeBase({ kbPath: 'kb' });
const entry = (id: string): VendorEntry => {
  const e = kb.byId.get(id);
  if (!e) throw new Error(`no vendor ${id}`);
  return e;
};
/** The day after an entry passes the staleness threshold. */
const staleDay = (e: VendorEntry) =>
  new Date(Date.parse(e.lastVerified) + (STALE_AFTER_DAYS + 1) * 86_400_000);
const freshDay = (e: VendorEntry) => new Date(Date.parse(e.lastVerified) + 86_400_000);
/** A copy of a shipped entry with its DPF records edited, so a case never rests on today's data. */
function withDpf(
  id: string,
  edit: (m: VendorEntry['legal']['transferMechanisms'][number]) => void,
): VendorEntry {
  const copy = structuredClone(entry(id));
  for (const m of copy.legal.transferMechanisms) if (m.mechanism === 'DPF') edit(m);
  return copy;
}
const fresh = { asOf: new Date('2026-11-03'), stale: false, dpfJurisdiction: true };
const reasons = (id: string, asOf: Date) =>
  kb.verifyTasks(entry(id), asOf).map((t) => `${t.fact}:${t.reason}`);

describe('verify tasks', () => {
  it('lists nothing for a fresh entry whose DPF status is Active', () => {
    expect(reasons('clerk', freshDay(entry('clerk')))).toEqual([]);
  });

  it('lists a qualified status nobody has accepted, even when fresh', () => {
    const qualified = withDpf('clerk', (m) => {
      m.observedStatus = 'Active - Re-certification under Review';
      m.dpfCertified = false;
    });
    expect(vendorTasks(qualified, fresh).map((t) => t.reason)).toEqual(['dpf-status-qualified']);
  });

  it('lists a certified record with no observed status', () => {
    const unobserved = structuredClone(entry('clerk'));
    unobserved.legal.transferMechanisms = unobserved.legal.transferMechanisms.map(
      ({ observedStatus: _, ...m }) => m,
    );
    expect(vendorTasks(unobserved, fresh).map((t) => t.reason)).toEqual(['dpf-status-unobserved']);
  });

  /** A copy of a shipped entry with no DPF record, whatever today's data holds. */
  const noDpf = (e: VendorEntry): VendorEntry => ({
    ...e,
    legal: {
      ...e.legal,
      transferMechanisms: e.legal.transferMechanisms.filter((m) => m.mechanism !== 'DPF'),
    },
  });

  it('lists a US vendor with no DPF record at all', () => {
    const openai = noDpf(entry('openai'));
    const tasks = kb.verifyTasks(openai, freshDay(openai));
    expect(tasks.map((t) => t.reason)).toEqual(['dpf-unknown']);
    expect(tasks[0]?.where).toEqual(['https://www.dataprivacyframework.gov/list']);
  });

  it('lists nothing once a search of the list is recorded as not-listed', () => {
    const openai = structuredClone(noDpf(entry('openai')));
    openai.legal.transferMechanisms.push({
      mechanism: 'DPF',
      dpfCertified: false,
      observedStatus: 'not-listed',
      url: 'https://www.dataprivacyframework.gov/list',
      lastChecked: openai.lastVerified,
    });
    expect(kb.verifyTasks(openai, freshDay(openai))).toEqual([]);
  });

  it('stops listing dpf-unknown when the DPF decision is assumed withdrawn', () => {
    const lapsed = loadKnowledgeBase({ kbPath: 'kb', assumeAdequacyLapsed: ['US:DPF'] });
    const openai = noDpf(lapsed.byId.get('openai') as VendorEntry);
    expect(lapsed.verifyTasks(openai, freshDay(openai))).toEqual([]);
  });

  it('lists every legal fact of a stale entry, each under its most specific reason', () => {
    expect(reasons('clerk', staleDay(entry('clerk')))).toEqual([
      'dpf:stale-entry',
      'dpa:stale-entry',
      'subprocessors:stale-entry',
    ]);
    const qualified = withDpf('clerk', (m) => {
      m.observedStatus = 'Active - Re-certification under Review';
      m.dpfCertified = false;
    });
    expect(vendorTasks(qualified, { ...fresh, stale: true })[0]?.reason).toBe(
      'dpf-status-qualified',
    );
  });

  it('accepts an accepted qualified status without a standing task', () => {
    const accepted = withDpf('clerk', (m) => {
      m.observedStatus = 'Active - Re-certification under Review';
      m.acceptQualifiedStatus = { acceptedBy: 'A Person', reason: 'x' };
    });
    expect(vendorTasks(accepted, fresh)).toEqual([]);
  });

  it('lists an unrecognised status', () => {
    const clerk = withDpf('clerk', (m) => {
      m.observedStatus = 'Pending';
      m.dpfCertified = false;
    });
    const [task] = vendorTasks(clerk, fresh);
    expect(task?.reason).toBe('dpf-status-unrecognised');
    expect(task?.current.value).toBe('Pending');
  });

  it('gives the same ids on every run and on any day the reason holds', () => {
    const e = entry('clerk');
    const a = kb.verifyTasks(e, staleDay(e)).map((t) => t.id);
    const later = new Date(staleDay(e).getTime() + 30 * 86_400_000);
    expect(kb.verifyTasks(e, staleDay(e)).map((t) => t.id)).toEqual(a);
    expect(kb.verifyTasks(e, later).map((t) => t.id)).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });

  it('points only at URLs the entry itself carries, or the DPF list', () => {
    for (const vendor of kb.vendors) {
      const text = readFileSync(join('kb/vendors', `${vendor.id}.json`), 'utf8');
      for (const task of kb.verifyTasks(vendor, staleDay(vendor))) {
        for (const url of task.where) {
          if (url === 'https://www.dataprivacyframework.gov/list') continue;
          expect(text, `${vendor.id}: ${url}`).toContain(JSON.stringify(url));
        }
      }
    }
  });
});

describe('knowledgeBaseTasks, behind pnpm kb:tasks', () => {
  const asOf = new Date('2027-09-06T00:00:00Z');

  it('is identical on two runs for the same date', () => {
    expect(knowledgeBaseTasks(kb, asOf)).toEqual(knowledgeBaseTasks(kb, asOf));
  });

  it('lists vendors in id order, and is what each entry yields on its own', () => {
    const sorted = [...kb.vendors].sort((a, b) => a.id.localeCompare(b.id));
    expect(knowledgeBaseTasks(kb, asOf)).toEqual(sorted.flatMap((v) => kb.verifyTasks(v, asOf)));
  });
});
