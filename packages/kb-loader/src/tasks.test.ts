import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STALE_AFTER_DAYS, type VendorEntry, loadKnowledgeBase } from './index.js';
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
const reasons = (id: string, asOf: Date) =>
  kb.verifyTasks(entry(id), asOf).map((t) => `${t.fact}:${t.reason}`);

describe('verify tasks', () => {
  it('lists nothing for a fresh entry whose DPF status is Active', () => {
    expect(reasons('clerk', freshDay(entry('clerk')))).toEqual([]);
  });

  it('lists a qualified status nobody has accepted, even when fresh', () => {
    expect(reasons('auth0', freshDay(entry('auth0')))).toEqual(['dpf:dpf-status-qualified']);
  });

  it('lists a certified record with no observed status', () => {
    expect(reasons('stripe', freshDay(entry('stripe')))).toContain('dpf:dpf-status-unobserved');
  });

  it('lists a US vendor with no DPF record at all', () => {
    const tasks = kb.verifyTasks(entry('openai'), freshDay(entry('openai')));
    expect(tasks.map((t) => t.reason)).toEqual(['dpf-unknown']);
    expect(tasks[0]?.where).toEqual(['https://www.dataprivacyframework.gov/list']);
  });

  it('stops listing dpf-unknown when the DPF decision is assumed withdrawn', () => {
    const lapsed = loadKnowledgeBase({ kbPath: 'kb', assumeAdequacyLapsed: ['US:DPF'] });
    const openai = lapsed.byId.get('openai') as VendorEntry;
    expect(lapsed.verifyTasks(openai, freshDay(openai))).toEqual([]);
  });

  it('lists every legal fact of a stale entry, each under its most specific reason', () => {
    expect(reasons('clerk', staleDay(entry('clerk')))).toEqual([
      'dpf:stale-entry',
      'dpa:stale-entry',
      'subprocessors:stale-entry',
    ]);
    expect(reasons('auth0', staleDay(entry('auth0')))[0]).toBe('dpf:dpf-status-qualified');
  });

  it('accepts an accepted qualified status without a standing task', () => {
    const auth0 = structuredClone(entry('auth0'));
    for (const m of auth0.legal.transferMechanisms) {
      if (m.mechanism === 'DPF') m.acceptQualifiedStatus = { acceptedBy: 'A Person', reason: 'x' };
    }
    expect(vendorTasks(auth0, { stale: false, dpfJurisdiction: true })).toEqual([]);
  });

  it('lists an unrecognised status', () => {
    const clerk = structuredClone(entry('clerk'));
    for (const m of clerk.legal.transferMechanisms) {
      if (m.mechanism === 'DPF') m.observedStatus = 'Pending';
    }
    const [task] = vendorTasks(clerk, { stale: false, dpfJurisdiction: true });
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
