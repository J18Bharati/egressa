import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '@adequacy/core';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { EXIT } from './exit-codes.js';
import { formatHuman } from './format/human.js';
import { formatMarkdown } from './format/markdown.js';
import { applySuppressions } from './suppress.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const result = () =>
  scan({
    root: 'fixtures/repos/express-stripe-sendgrid',
    toolVersion: '0.1.0',
    kbPath: 'kb',
    now: NOW,
  });

describe('suppressions', () => {
  const config = {
    suppressions: [
      { vendor: 'stripe', reason: 'SCCs signed; ticket PRIV-1', expires: '2027-01-01' },
    ],
  };

  it('marks a finding suppressed without removing it', () => {
    const suppressed = applySuppressions(result(), config, NOW);
    expect(suppressed.findings).toHaveLength(1);
    expect(suppressed.findings[0]?.suppressed).toBe(true);
    expect(suppressed.findings[0]?.suppression?.reason).toContain('PRIV-1');
    expect(suppressed.summary.suppressed).toBe(1);
  });

  it('reactivates an expired suppression and adds an expiry note', () => {
    const expiredConfig = {
      suppressions: [{ vendor: 'stripe', reason: 'temporary', expires: '2026-01-01' }],
    };
    const out = applySuppressions(result(), expiredConfig, NOW);
    const active = out.findings.find((f) => f.ruleId !== 'config/expired-suppression');
    const note = out.findings.find((f) => f.ruleId === 'config/expired-suppression');

    expect(active?.suppressed).toBe(false);
    expect(active?.suppression?.expired).toBe(true);
    expect(note).toBeDefined();
    expect(note?.remediation.summary).toContain('expired on 2026-01-01');
  });

  it('leaves other vendors untouched', () => {
    const out = applySuppressions(
      result(),
      { suppressions: [{ vendor: 'sentry', reason: 'x' }] },
      NOW,
    );
    expect(out.findings[0]?.suppressed).toBe(false);
  });
});

describe('config', () => {
  it('treats a missing config as normal, not an error', () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), 'adq-')))).toEqual({});
  });

  it('refuses a suppression with no reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(
      join(dir, '.adequacy.yml'),
      'version: 1\nsuppressions:\n  - vendor: stripe\n    reason: ""\n',
    );
    expect(() => loadConfig(dir)).toThrow(/must say why/);
  });

  it('reads suppressions and excludes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(
      join(dir, '.adequacy.yml'),
      'version: 1\nexclude: ["**/legacy/**"]\nsuppressions:\n  - vendor: stripe\n    reason: accepted for now\n',
    );
    const config = loadConfig(dir);
    expect(config.exclude).toEqual(['**/legacy/**']);
    expect(config.suppressions?.[0]?.reason).toBe('accepted for now');
  });
});

describe('human output', () => {
  it('states what a clean scan does not prove', () => {
    const clean = scan({
      root: 'fixtures/repos/clean-eu-only',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      now: NOW,
    });
    const text = formatHuman(clean, { color: false });
    expect(text).toContain('Server-side proxying');
    expect(text).toContain('not a statement that none exists');
  });

  it('shows jurisdictions, EU region scope and the verification date', () => {
    const text = formatHuman(result(), { color: false });
    expect(text).toContain('processing: US, IE');
    expect(text).toContain('EU region:  not documented');
    expect(text).toContain('verified:   2026-09-06');
  });

  it('flags a hypothetical run so it cannot be mistaken for the current position', () => {
    const lapsed = scan({
      root: 'fixtures/repos/express-stripe-sendgrid',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      now: NOW,
      assumeAdequacyLapsed: ['US:DPF'],
    });
    expect(formatHuman(lapsed, { color: false })).toContain('hypothetical');
  });
});

describe('markdown output', () => {
  it('carries the full disclaimer and a per-vendor table', () => {
    const md = formatMarkdown(result());
    expect(md).toContain('does not assess or certify GDPR compliance');
    expect(md).toContain('| Vendor | Processing | EU region | Rule | Confidence |');
    expect(md).toContain('Stripe, LLC');
  });

  it('says how many findings it withheld when truncating', () => {
    const md = formatMarkdown(result(), { maxFindings: 0 });
    expect(md).toContain('1 further finding(s) not shown');
  });
});

describe('cli end to end', () => {
  const run = (args: string[]) => {
    try {
      const stdout = execFileSync('npx', ['tsx', 'packages/cli/src/cli.ts', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout };
    } catch (error) {
      const e = error as { status: number; stdout: string };
      return { code: e.status, stdout: e.stdout ?? '' };
    }
  };

  it('exits 0 by default even when it finds something', () => {
    // Breaking CI on first install is how a tool gets uninstalled.
    const { code } = run([
      'scan',
      'fixtures/repos/express-stripe-sendgrid',
      '--kb',
      'kb',
      '--quiet',
    ]);
    expect(code).toBe(EXIT.CLEAN);
  });

  it('exits 1 only when --fail-on is opted into and reached', () => {
    const { code } = run([
      'scan',
      'fixtures/repos/express-stripe-sendgrid',
      '--kb',
      'kb',
      '--assume-adequacy-lapsed',
      'US:DPF',
      '--fail-on',
      'warning',
      '--quiet',
    ]);
    expect(code).toBe(EXIT.FINDINGS);
  });

  it('rejects a bad --fail-on value as a usage error, not a finding', () => {
    const { code } = run(['scan', 'fixtures/repos/clean-eu-only', '--fail-on', 'nonsense']);
    expect(code).toBe(EXIT.USAGE);
  });

  it('emits schema-shaped JSON', () => {
    const { stdout } = run([
      'scan',
      'fixtures/repos/express-stripe-sendgrid',
      '--kb',
      'kb',
      '--format',
      'json',
    ]);
    const parsed = JSON.parse(stdout) as { schemaVersion: string; disclaimer: string };
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.disclaimer).toContain('does not assess or certify');
  });

  it('explains a rule without needing a scan', () => {
    const { stdout } = run(['explain', 'transfer/third-country-egress']);
    expect(stdout).toContain('Chapter V');
    expect(stdout).toContain('does not assess or certify GDPR compliance');
  });

  it('lists the knowledge base without needing a scan', () => {
    const { stdout } = run(['vendors', 'list', '--kb', 'kb']);
    expect(stdout).toContain('stripe');
    expect(stdout).toContain('payments');
  });

  it('resolves a vendor by package name', () => {
    const { stdout } = run(['vendors', 'show', '@sentry/nextjs', '--kb', 'kb']);
    expect(stdout).toContain('Functional Software');
  });
});
