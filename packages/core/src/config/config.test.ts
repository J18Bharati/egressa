import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../scan.js';
import { summarise } from '../summarize.js';
import { ConfigError, applySuppressions, loadConfig } from './index.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const result = (config = {}) =>
  scan({
    root: 'fixtures/repos/express-stripe-sendgrid',
    toolVersion: '0.1.0',
    kbPath: 'kb',
    now: NOW,
    config,
  });

describe('suppressions, applied by scan()', () => {
  const config = {
    suppressions: [
      { vendor: 'stripe', reason: 'SCCs signed; ticket PRIV-1', expires: '2027-01-01' },
    ],
  };

  it('marks a finding suppressed without removing it', () => {
    const out = result(config);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.suppressed).toBe(true);
    expect(out.findings[0]?.suppression?.reason).toContain('PRIV-1');
    expect(out.summary.suppressed).toBe(1);
  });

  it('reactivates an expired suppression and puts its note right after it', () => {
    const out = result({
      suppressions: [{ vendor: 'stripe', reason: 'temporary', expires: '2026-01-01' }],
    });
    expect(out.findings.map((f) => f.ruleId)).toEqual([
      out.findings[0]?.ruleId,
      'config/expired-suppression',
    ]);
    expect(out.findings[0]?.suppressed).toBe(false);
    expect(out.findings[0]?.suppression?.expired).toBe(true);
    expect(out.findings[1]?.remediation.summary).toContain('expired on 2026-01-01');
    // Counted like any other finding, which the CLI used to skip.
    expect(out.summary.byRule['config/expired-suppression']).toBe(1);
    expect(out.summary.findingCount).toBe(2);
  });

  it('leaves other vendors untouched', () => {
    const out = result({ suppressions: [{ vendor: 'sentry', reason: 'x' }] });
    expect(out.findings[0]?.suppressed).toBe(false);
  });

  it('keeps each expiry note beside its finding, so a summary cannot cut one without the other', () => {
    const finding = (id: string) => ({ ...result().findings[0], id, vendor: null }) as never;
    const withVendor = (id: string, vendorId: string) =>
      ({
        ...(finding(id) as object),
        vendor: { id: vendorId, name: vendorId },
      }) as never;
    const out = applySuppressions(
      [withVendor('a', 'a'), withVendor('b', 'b'), withVendor('c', 'c')],
      { suppressions: [{ vendor: 'a', reason: 'r', expires: '2000-01-01' }] },
      NOW,
    );
    expect(out.map((f) => f.id)).toEqual(['a', 'a-expired', 'b', 'c']);
    const shown = summarise({ ...result(), findings: out }, { maxFindings: 2 });
    expect(shown.findings.map((f) => f.ruleId).at(-1)).toBe('config/expired-suppression');
  });
});

describe('the rest of the config, applied by scan()', () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'egressa-config-'));
    mkdirSync(join(dir, 'legacy'));
    writeFileSync(join(dir, 'legacy', 'a.ts'), "fetch('https://api.openai.com/v1/x');\n");
    writeFileSync(join(dir, 'vendor.ts'), "fetch('https://api.stripe.com/v1/x');\n");
    return dir;
  };
  const vendors = (out: ReturnType<typeof scan>) => out.findings.map((f) => f.vendor?.id).sort();

  it('adds its excludes to the caller’s, config first, and records both', () => {
    const root = repo();
    const out = scan({
      root,
      toolVersion: '0',
      kbPath: 'kb',
      includeCallsites: true,
      config: { exclude: ['legacy/**'] },
      exclude: ['vendor.ts'],
    });
    expect(vendors(out)).toEqual([]);
    expect(out.scan.exclude).toEqual(['legacy/**', 'vendor.ts']);
  });

  it('lets an explicit includeTransitive override the config', () => {
    // @supabase/auth-js is one of the few aliases detected transitively, so
    // whether transitive records are kept is visible in the findings.
    const root = mkdtempSync(join(tmpdir(), 'egressa-config-'));
    writeFileSync(join(root, 'package.json'), '{"name":"x","dependencies":{"foo":"1"}}');
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'x', dependencies: { foo: '1' } },
          'node_modules/foo': { version: '1' },
          'node_modules/@supabase/auth-js': { version: '2' },
        },
      }),
    );
    const run = (options: { includeTransitive?: boolean }) =>
      vendors(
        scan({
          root,
          toolVersion: '0',
          kbPath: 'kb',
          config: { includeTransitive: true },
          ...options,
        }),
      );
    expect(run({})).toEqual(['supabase']);
    expect(run({ includeTransitive: false })).toEqual([]);
  });
});

describe('loadConfig', () => {
  const dirWith = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(join(dir, '.egressa.yml'), text);
    return dir;
  };

  it('treats a missing config as normal, not an error', () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), 'adq-')))).toEqual({});
  });

  it('refuses a suppression with no reason', () => {
    const dir = dirWith('version: 1\nsuppressions:\n  - vendor: stripe\n    reason: ""\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/must say why/);
  });

  it('reads suppressions and excludes, and says where from', () => {
    const dir = dirWith(
      'version: 1\nexclude: ["**/legacy/**"]\nsuppressions:\n  - vendor: stripe\n    reason: accepted for now\n',
    );
    const config = loadConfig(dir);
    expect(config.exclude).toEqual(['**/legacy/**']);
    expect(config.suppressions?.[0]?.reason).toBe('accepted for now');
    expect(config.source).toBe('.egressa.yml');
  });

  it('reports malformed YAML as a ConfigError naming the file', () => {
    const dir = dirWith('exclude: [legacy/**\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/\.egressa\.yml/);
  });

  it('checks its exclude globs itself, so a bad one is a ConfigError', () => {
    expect(() => loadConfig(dirWith('exclude: ["!legacy/**"]\n'))).toThrow(ConfigError);
    expect(() => loadConfig(dirWith('exclude: [legacy/**, 2024]\n'))).toThrow(ConfigError);
    expect(() => loadConfig(dirWith('exclude: 7\n'))).toThrow(ConfigError);
  });
});
