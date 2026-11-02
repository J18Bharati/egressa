import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKnowledgeBase } from '@egressa/kb';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { findForbiddenClaims } from './claims.js';
import { loadConfig } from './config/index.js';
import { scan } from './scan.js';
import { FINDINGS_SCHEMA_VERSION } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateFindings = ajv.compile(
  JSON.parse(readFileSync(`schemas/findings-${FINDINGS_SCHEMA_VERSION}.json`, 'utf8')) as object,
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

  it('finds the vendors it has entries for', () => {
    expect(result.findings.map((f) => f.vendor?.id).sort()).toEqual(['sendgrid', 'stripe']);
  });

  it('classifies Stripe as adequate-country egress while the framework stands', () => {
    expect(result.findings[0]?.ruleId).toBe('transfer/adequate-country-egress');
    expect(result.findings[0]?.exposure?.adequacyDependent).toBe(true);
  });

  it('gives an official SDK dependency high confidence', () => {
    expect(result.findings[0]?.confidence).toBe('high');
  });

  it('keeps every location as evidence on one finding, not one finding per line', () => {
    const ids = result.findings.map((f) => f.vendor?.id);
    expect(new Set(ids).size).toBe(ids.length);
    const stripe = result.findings.find((f) => f.vendor?.id === 'stripe');
    expect(stripe?.evidence.length).toBeGreaterThan(1);
  });

  it('reports declared packages it does not recognise, as the recall signal', () => {
    expect(result.unmatched.packages).toContain('express');
    expect(result.unmatched.packages).not.toContain('@sendgrid/mail');
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
    expect(high.findings.length).toBeGreaterThan(0);
    expect(high.findings.every((f) => f.confidence === 'high')).toBe(true);
  });

  it('reports the knowledge base version and adequacy date for auditability', () => {
    const result = scan({ ...base, root });
    // Read from kb/ rather than pinned: the version moves whenever the data
    // does, and asserting a literal here only ever fails for that reason.
    expect(result.kb.version).toBe(readFileSync('kb/kb.version', 'utf8').trim());
    expect(result.kb.adequacyStatusAsOf).toBe('2026-09-06');
    expect(result.kb.entryCount).toBe(
      readdirSync('kb/vendors').filter((f) => f.endsWith('.json')).length,
    );
  });

  it('reports no stale entries today and all of them a year on', () => {
    expect(scan({ ...base, root }).kb.staleEntryCount).toBe(0);
    // A year on, every entry is past the 180-day threshold, whatever the count.
    const entries = readdirSync('kb/vendors').filter((f) => f.endsWith('.json')).length;
    expect(scan({ ...base, root, now: new Date('2027-09-06') }).kb.staleEntryCount).toBe(entries);
  });
});

describe('scan: a document carrying regions', () => {
  // The express-stripe-sendgrid fixture has no region, so it validated happily
  // against a schema that rejected every region-bearing document -- the signal
  // item is additionalProperties:false. A scan with regions has to be checked
  // separately or the gap reopens the next time a field is added.
  const result = scan({
    ...base,
    root: 'fixtures/repos/regional-multi',
    includeCallsites: true,
  });

  it('validates against the published schema', () => {
    const ok = validateFindings(result);
    if (!ok) expect(validateFindings.errors?.slice(0, 5)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('actually carries a region, so the assertion above is not vacuous', () => {
    expect(result.findings.some((f) => f.signals.some((s) => s.region))).toBe(true);
    expect(result.findings.some((f) => f.evidence.some((e) => e.region))).toBe(true);
  });
});

describe('a document carrying an unmapped region', () => {
  it('validates, with the flag on the evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'egressa-unmapped-schema-'));
    writeFileSync(join(root, 'main.tf'), 'provider "aws" {\n  region = "eu-wset-1"\n}\n');
    const result = scan({ ...base, root });
    expect(result.findings.flatMap((f) => f.evidence).some((e) => e.regionUnmapped)).toBe(true);
    const ok = validateFindings(result);
    if (!ok) expect(validateFindings.errors?.slice(0, 5)).toEqual([]);
  });
});

describe('exclude globs that cannot be honoured', () => {
  it('throws on a negated glob rather than scanning wider than asked', () => {
    expect(() =>
      scan({ ...base, root: 'fixtures/repos/clean-eu-only', exclude: ['!x/**'] }),
    ).toThrow(/cannot be negated/);
  });

  it('throws on an entry that is not a string', () => {
    const exclude = ['a/**', 2024] as unknown as string[];
    expect(() => scan({ ...base, root: 'fixtures/repos/clean-eu-only', exclude })).toThrow(
      /must be glob strings/,
    );
  });
});

describe('deployment config reaches the region reader in the right language', () => {
  const regionsIn = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'egressa-iac-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    const result = scan({ root, toolVersion: '0', kbPath: 'kb' });
    return result.findings.flatMap((f) => f.evidence.map((e) => e.region)).filter(Boolean);
  };

  it('reads a .tf file as HCL, so a heredoc cannot declare a provider', () => {
    const tf = [
      'resource "local_file" "p" {',
      '  content = <<EOF',
      'provider "aws" {',
      '  region = "us-west-2"',
      '}',
      'EOF',
      '}',
      'provider "aws" {',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(regionsIn({ 'main.tf': tf })).toEqual(['eu-west-1']);
  });

  it('reads fly.toml as TOML, top-level primary_region only', () => {
    const fly = "app = 'demo'\nprimary_region = 'fra'\n[env]\n  primary_region = \"iad\"\n";
    expect(regionsIn({ 'fly.toml': fly })).toEqual(['fra']);
  });
});

describe('the document says which config it applied', () => {
  // Field test 4, E21. Only the MCP summary named the file, so the CLI's JSON
  // and MCP's full document never said a repository had scoped its own scan.
  const root = 'fixtures/repos/express-stripe-sendgrid';

  it('names the config file, and still validates', () => {
    const result = scan({
      ...base,
      root,
      config: { source: '.egressa.yml', suppressions: [{ vendor: 'stripe', reason: 'x' }] },
    });
    expect(result.scan.config).toBe('.egressa.yml');
    expect(validateFindings(result)).toBe(true);
  });

  it('says null when there is none', () => {
    const result = scan({ ...base, root });
    expect(result.scan.config).toBeNull();
    expect(validateFindings(result)).toBe(true);
  });
});

describe('scan: loopback and documentation hosts', () => {
  it('does not report a reserved name as an unknown vendor, and still reports a real one', () => {
    const root = mkdtempSync(join(tmpdir(), 'egressa-reserved-'));
    writeFileSync(
      join(root, 'a.ts'),
      [
        "fetch('http://localhost:3000/api');",
        "fetch('http://127.0.0.1:8080/x');",
        "fetch('https://api.example.com/v1');",
        "fetch('https://unknown-vendor.io/v1');",
      ].join('\n'),
    );
    const result = scan({ ...base, root, includeCallsites: true });
    expect(result.scan.engine.callsite).toBe('oxc');
    expect(result.unmatched.hosts).toEqual(['unknown-vendor.io']);
    const matched = result.findings.flatMap((f) => f.evidence.map((e) => e.matchedOn));
    expect(matched).toEqual(['unknown-vendor.io']);
  });
});

describe('scan: kb/stale-entry notes', () => {
  const root = 'fixtures/repos/express-stripe-sendgrid';
  const later = new Date('2027-09-06T12:00:00.000Z');
  const stale = scan({ ...base, root, now: later });
  const notes = stale.findings.filter((f) => f.ruleId === 'kb/stale-entry');

  it('emits none while every entry is fresh', () => {
    expect(scan({ ...base, root }).findings.some((f) => f.ruleId === 'kb/stale-entry')).toBe(false);
  });

  it('emits exactly one note per stale matched vendor, directly after its first finding', () => {
    const vendors = new Set(
      stale.findings.filter((f) => f.ruleId !== 'kb/stale-entry').map((f) => f.vendor?.id),
    );
    vendors.delete(undefined);
    expect(notes.map((n) => n.vendor?.id).sort()).toEqual([...vendors].sort());
    for (const note of notes) {
      const at = stale.findings.indexOf(note);
      const first = stale.findings.findIndex((f) => f.vendor?.id === note.vendor?.id);
      expect(at).toBe(first + 1);
      expect(note.severity).toBe('note');
      expect(note.exposure).toBeNull();
    }
  });

  it('carries the stale vendor tasks on the note and not on the finding', () => {
    for (const note of notes) {
      expect(note.verification?.some((t) => t.reason === 'stale-entry')).toBe(true);
      const findings = stale.findings.filter(
        (f) => f.vendor?.id === note.vendor?.id && f.ruleId !== 'kb/stale-entry',
      );
      for (const f of findings) expect(f.verification).toBeUndefined();
    }
  });

  it('validates against the published schema', () => {
    const ok = validateFindings(stale);
    if (!ok) expect(validateFindings.errors?.slice(0, 5)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('gives the same ids on two runs and on two stale dates', () => {
    const ids = (r: ReturnType<typeof scan>) =>
      r.findings.map((f) => [f.id, ...(f.verification ?? []).map((t) => t.id)]);
    expect(ids(scan({ ...base, root, now: later }))).toEqual(ids(stale));
    expect(ids(scan({ ...base, root, now: new Date('2028-01-01T00:00:00Z') }))).toEqual(ids(stale));
  });

  it('no longer appends a staleness sentence to the vendor finding itself', () => {
    for (const f of stale.findings.filter((x) => x.ruleId !== 'kb/stale-entry')) {
      expect(f.remediation.summary).not.toMatch(/re-verified recently/);
    }
  });

  it('can be suppressed by rule like any other finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egressa-stale-'));
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"stripe":"^14.0.0"}}');
    writeFileSync(
      join(dir, '.egressa.yml'),
      'suppressions:\n  - rule: kb/stale-entry\n    reason: re-verification scheduled\n',
    );
    const result = scan({ ...base, root: dir, now: later, config: loadConfig(dir) });
    const note = result.findings.find((f) => f.ruleId === 'kb/stale-entry');
    expect(note?.suppressed).toBe(true);
    expect(result.errors.filter((e) => /suppression/.test(e.message))).toEqual([]);
  });
});

describe('scan: verification tasks on fresh findings', () => {
  it('asks for a local entry on an unknown vendor, naming what was seen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egressa-unknown-'));
    writeFileSync(
      join(dir, 'send.js'),
      "export const send = (b) => fetch('https://api.unlisted-vendor.io/v1/events', { method: 'POST', body: b });\n",
    );
    const result = scan({ ...base, root: dir, includeCallsites: true });
    const unknown = result.findings.filter((f) => f.ruleId === 'transfer/unknown-vendor-egress');
    expect(unknown).toHaveLength(1);
    for (const f of unknown) {
      expect(f.verification).toEqual([
        expect.objectContaining({
          vendorId: null,
          fact: 'local-entry',
          reason: 'unknown-vendor',
          subject: f.evidence[0]?.matchedOn,
          where: [],
        }),
      ]);
    }
  });
});

describe('scan: what the skills promise about kb/stale-entry', () => {
  // The skills tell an agent what a kb/stale-entry finding is and what to do
  // with it. For a long time the rule existed and nothing emitted it, so the
  // promise was to a finding no scan could produce.
  it('is emitted whenever a skill mentions it', () => {
    const skillText = execFileSync('grep', ['-rl', 'kb/stale-entry', 'skill'], {
      encoding: 'utf8',
    });
    expect(skillText.trim()).not.toBe('');
    const result = scan({
      ...base,
      root: 'fixtures/repos/express-stripe-sendgrid',
      now: new Date('2027-09-06T12:00:00.000Z'),
    });
    expect(result.findings.some((f) => f.ruleId === 'kb/stale-entry')).toBe(true);
  });
});
