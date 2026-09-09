import { readFileSync } from 'node:fs';
import { loadKnowledgeBase } from '@egressa/kb';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { findForbiddenClaims } from './claims.js';
import { scan } from './scan.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateFindings = ajv.compile(
  JSON.parse(readFileSync('schemas/findings-1.0.0.json', 'utf8')) as object,
);

const NOW = new Date('2026-09-06T12:00:00.000Z');
const base = { toolVersion: '0.1.0', kbPath: 'kb', now: NOW };

describe('scan: express-stripe-sendgrid fixture', () => {
  const result = scan({ ...base, root: 'fixtures/repos/express-stripe-sendgrid' });

  it('emits a document that validates against the published schema', () => {
    const ok = validateFindings(result);
    if (!ok) expect(validateFindings.errors?.slice(0, 5)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('carries the disclaimer and no forbidden claim words', () => {
    expect(result.disclaimer).toContain('does not assess or certify GDPR compliance');
    expect(findForbiddenClaims(JSON.stringify(result))).toEqual([]);
  });

  it('finds the vendor it has an entry for', () => {
    expect(result.findings.map((f) => f.vendor?.id)).toEqual(['stripe']);
  });

  it('classifies Stripe as adequate-country egress while the framework stands', () => {
    expect(result.findings[0]?.ruleId).toBe('transfer/adequate-country-egress');
    expect(result.findings[0]?.exposure?.adequacyDependent).toBe(true);
  });

  it('gives an official SDK dependency high confidence', () => {
    expect(result.findings[0]?.confidence).toBe('high');
  });

  it('keeps every location as evidence on one finding, not one finding per line', () => {
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.evidence.length).toBeGreaterThan(1);
  });

  it('reports declared packages it does not recognise, as the recall signal', () => {
    expect(result.unmatched.packages).toContain('@sendgrid/mail');
    expect(result.unmatched.packages).toContain('express');
  });

  it('does not report transitive packages as coverage gaps', () => {
    expect(result.unmatched.packages).not.toContain('qs');
  });

  it('links the DPA and sub-processor pages in remediation', () => {
    const links = result.findings[0]?.remediation.links.map((l) => l.url) ?? [];
    expect(links).toContain('https://stripe.com/legal/dpa');
    expect(links).toContain('https://stripe.com/legal/service-providers');
  });

  it('is deterministic across runs', () => {
    const again = scan({ ...base, root: 'fixtures/repos/express-stripe-sendgrid' });
    const strip = (r: unknown) => JSON.stringify(r, (k, v) => (k === 'durationMs' ? 0 : v));
    expect(strip(result)).toBe(strip(again));
  });
});

describe('scan: what breaks if adequacy lapses', () => {
  it('re-rates the same repository from a single data change', () => {
    const before = scan({ ...base, root: 'fixtures/repos/express-stripe-sendgrid' });
    const after = scan({
      ...base,
      root: 'fixtures/repos/express-stripe-sendgrid',
      assumeAdequacyLapsed: ['US:DPF'],
    });

    expect(before.findings[0]?.ruleId).toBe('transfer/adequate-country-egress');
    expect(before.findings[0]?.severity).toBe('note');

    expect(after.findings[0]?.ruleId).toBe('transfer/third-country-egress');
    expect(after.findings[0]?.severity).toBe('warning');
    expect(after.findings[0]?.exposure?.level).toBe('elevated');
    expect(after.scan.assumedAdequacyLapsed).toEqual(['US:DPF']);
  });
});

describe('scan: clean-eu-only fixture', () => {
  const result = scan({ ...base, root: 'fixtures/repos/clean-eu-only' });

  it('produces no findings at all: the false-positive guard', () => {
    expect(result.findings).toEqual([]);
    expect(result.summary.findingCount).toBe(0);
  });

  it('still validates and still carries the disclaimer', () => {
    expect(validateFindings(result)).toBe(true);
    expect(result.disclaimer.length).toBeGreaterThan(0);
  });
});

describe('scan: options', () => {
  const root = 'fixtures/repos/express-stripe-sendgrid';

  it('honours minConfidence', () => {
    const kb = loadKnowledgeBase({ kbPath: 'kb' });
    const high = scan({ ...base, root, kb, minConfidence: 'high' });
    expect(high.findings).toHaveLength(1);
  });

  it('reports the knowledge base version and adequacy date for auditability', () => {
    const result = scan({ ...base, root });
    expect(result.kb.version).toBe('2026.09.01');
    expect(result.kb.adequacyStatusAsOf).toBe('2026-09-06');
    expect(result.kb.entryCount).toBe(5);
  });

  it('reports no stale entries today and all of them a year on', () => {
    expect(scan({ ...base, root }).kb.staleEntryCount).toBe(0);
    expect(scan({ ...base, root, now: new Date('2027-09-06') }).kb.staleEntryCount).toBe(5);
  });
});
