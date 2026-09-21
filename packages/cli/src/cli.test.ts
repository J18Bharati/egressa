import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FINDINGS_SCHEMA_VERSION, scan } from '@egressa/core';
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
      join(dir, '.egressa.yml'),
      'version: 1\nsuppressions:\n  - vendor: stripe\n    reason: ""\n',
    );
    expect(() => loadConfig(dir)).toThrow(/must say why/);
  });

  it('reads suppressions and excludes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(
      join(dir, '.egressa.yml'),
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
    expect(parsed.schemaVersion).toBe(FINDINGS_SCHEMA_VERSION);
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

describe('negated flags actually change the scan', () => {
  // These four parsed cleanly and did nothing for the whole of v1. citty already
  // implements `--no-x` as negation of `x`, so declaring an argument *named*
  // `no-callsites` made citty write `callsites: false` while the code kept
  // reading `args['no-callsites']`, which stayed at its default forever.
  // Each test below fails if that regresses, because each asserts an observable
  // difference rather than the parsed value.
  const json = (args: string[]) => {
    const stdout = execFileSync('npx', ['tsx', 'packages/cli/src/cli.ts', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout) as ReturnType<typeof scan>;
  };

  it('--no-callsites disables call-site analysis', () => {
    const base = ['scan', 'fixtures/repos/unresolvable-hosts', '--format', 'json'];
    // Every finding in this fixture comes from a call site, so switching the
    // analyser off must take the count to zero.
    expect(json(base).summary.findingCount).toBe(3);
    const off = json([...base, '--no-callsites']);
    expect(off.summary.findingCount).toBe(0);
    expect(off.scan.engine.callsite).toBe('disabled');
  });

  it('--no-manifests stops dependency signals without touching call sites', () => {
    const base = ['scan', 'fixtures/repos/nextjs-analytics-heavy', '--format', 'json'];
    const on = json(base);
    expect(on.scan.manifestsScanned).toBe(1);
    expect(on.findings.some((f) => f.signals.some((s) => s.kind === 'dependency'))).toBe(true);

    const off = json([...base, '--no-manifests']);
    expect(off.scan.manifestsScanned).toBe(0);
    expect(off.findings.some((f) => f.signals.some((s) => s.kind === 'dependency'))).toBe(false);
    // Call sites are a separate analyser and must survive.
    expect(off.findings.some((f) => f.signals.some((s) => s.kind === 'callsite'))).toBe(true);
  });

  it('--no-dev drops a vendor that appears only in devDependencies', () => {
    const base = ['scan', 'fixtures/repos/dev-only-vendor', '--format', 'json'];
    const on = json(base);
    expect(on.summary.findingCount).toBe(1);
    // dev-only carries reduced confidence, which is the other half of the contract.
    expect(on.findings[0]?.signals[0]?.devOnly).toBe(true);
    expect(on.findings[0]?.confidence).toBe('medium');

    expect(json([...base, '--no-dev']).summary.findingCount).toBe(0);
  });

  it('declares no boolean argument with a "no-" prefix', () => {
    // The structural guard. Behavioural tests above catch these four; this one
    // catches the fifth someone adds later, before it can silently do nothing.
    const source = readFileSync('packages/cli/src/commands/scan.ts', 'utf8');
    const declared = [...source.matchAll(/^\s*'?([a-z-]+)'?:\s*\{\s*type:\s*'boolean'/gm)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(3);
    expect(declared.filter((name) => name?.startsWith('no-'))).toEqual([]);
  });
});

describe('output survives a pipe', () => {
  // The bug was that process.exit() does not flush a pipe, so a document
  // larger than the 64 KB buffer arrived truncated and, for json, unparseable.
  //
  // It has to be a *shell* pipeline. execFileSync's own stdio pipe is drained
  // by the parent as the child writes and never reproduces this -- an earlier
  // version of these tests used it and passed against the unfixed code, which
  // is a test that cannot fail. `sh -c '... | cat'` reproduces it every time.
  //
  // Every fixture repository is far below 64 KB, so this scans the repository
  // itself: the smallest input on hand that crosses the threshold.
  const pipeSelf = (format: string) =>
    execFileSync(
      'sh',
      ['-c', `npx tsx packages/cli/src/cli.ts scan . --format ${format} 2>/dev/null | cat`],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );

  it.skipIf(process.platform === 'win32')(
    'emits json that parses when it is larger than the pipe buffer',
    () => {
      const stdout = pipeSelf('json');
      // Crossing the buffer is the whole point: if this document ever shrinks
      // below 64 KB the assertion stops guarding anything and this test needs
      // a larger input rather than a smaller threshold.
      expect(stdout.length).toBeGreaterThan(65536);
      const doc = JSON.parse(stdout);
      expect(doc.schemaVersion).toBe(FINDINGS_SCHEMA_VERSION);
      expect(doc.findings.length).toBeGreaterThan(0);
    },
  );
});
