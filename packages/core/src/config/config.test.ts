import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../scan.js';
import { summarise } from '../summarize.js';
import { ConfigError, applySuppressions, loadConfig, suppressionProblems } from './index.js';

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

describe('what the branch review found loadConfig letting through', () => {
  // Each reached output that breaks the published schema, made a suppression
  // permanent, or failed as something other than a usage error.
  const dirWith = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(join(dir, '.egressa.yml'), text);
    return dir;
  };
  const refuses = (text: string, message: RegExp) => {
    const dir = dirWith(text);
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(message);
  };

  it('refuses suppressions that are not a list of entries', () => {
    refuses('suppressions: nope\n', /suppressions must be a list/);
    refuses('suppressions:\n  - stripe\n', /suppression 1 must be a mapping/);
  });

  it('refuses a reason, vendor, rule or acceptedBy that is not text', () => {
    refuses('suppressions:\n  - vendor: stripe\n    reason: 42\n', /reason must be text/);
    refuses('suppressions:\n  - vendor: 5\n    reason: x\n', /vendor must be text/);
    refuses(
      'suppressions:\n  - vendor: stripe\n    reason: x\n    acceptedBy: 7\n',
      /acceptedBy must be text/,
    );
  });

  it('refuses a suppression that names neither a vendor nor a rule', () => {
    refuses('suppressions:\n  - reason: x\n', /names neither a vendor nor a rule/);
  });

  it('refuses an expiry that is not a date, rather than never expiring', () => {
    refuses('suppressions:\n  - vendor: stripe\n    reason: x\n    expires: never\n', /expires/);
    refuses('suppressions:\n  - vendor: stripe\n    reason: x\n    expires: 20200101\n', /expires/);
  });

  it('refuses includeTransitive that is not true or false', () => {
    refuses('includeTransitive: "yes"\n', /includeTransitive must be true or false/);
  });

  it('refuses an explicit config path that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    expect(() => loadConfig(dir, join(dir, 'missing.yml'))).toThrow(ConfigError);
  });
});

describe('a config reached through a symlink', () => {
  // The review found a YAML error quoting lines of whatever file the link
  // pointed at, which MCP returned to the calling agent.
  it('refuses a .egressa.yml that resolves outside the scan root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'adq-secret-'));
    writeFileSync(join(outside, 'secret.txt'), 'API_KEY: [unterminated sk_live_123\n');
    const root = mkdtempSync(join(tmpdir(), 'adq-'));
    symlinkSync(join(outside, 'secret.txt'), join(root, '.egressa.yml'));
    expect(() => loadConfig(root)).toThrow(ConfigError);
    expect(() => loadConfig(root)).toThrow(/outside the repository/);
    expect(() => loadConfig(root)).not.toThrow(/sk_live/);
  });

  it('does not quote the file in a YAML error', () => {
    const root = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(join(root, '.egressa.yml'), 'exclude: [legacy/** sk_live_123\n');
    expect(() => loadConfig(root)).toThrow(ConfigError);
    expect(() => loadConfig(root)).not.toThrow(/sk_live/);
  });
});

describe('what field test 4 found loadConfig letting through', () => {
  // Each left a suppression permanent, or a team's config silently unread.
  const dirWith = (content: string | Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(join(dir, '.egressa.yml'), content);
    return dir;
  };
  const refuses = (content: string | Buffer, message: RegExp) => {
    const dir = dirWith(content);
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(message);
  };
  const entry = (extra: string) => `suppressions:\n  - vendor: stripe\n    reason: x\n${extra}`;

  it('refuses an unknown key, with a hint when it is a near miss', () => {
    refuses(entry('    expiry: "2020-01-01"\n'), /unknown key "expiry".*expires/);
    refuses(
      'suppresions:\n  - {vendor: stripe, reason: x}\n',
      /unknown key "suppresions".*suppressions/,
    );
    refuses('excludes: [a/**]\n', /unknown key "excludes"/);
  });

  it('refuses a YAML merge key rather than dropping what it carries', () => {
    refuses(
      'suppressions:\n  - &b {vendor: sentry, reason: y, expires: "2020-01-01"}\n  - vendor: stripe\n    reason: x\n    <<: *b\n',
      /suppression 2: merge keys are not supported/,
    );
    // An anchor kept under its own top-level key is refused as an unknown key.
    refuses('base: &b {expires: "2020-01-01"}\n', /unknown key "base"/);
  });

  it('does not echo a key that is not a plain name', () => {
    const dir = dirWith('"sk_live_123 secret": 1\n');
    expect(() => loadConfig(dir)).toThrow(/an unrecognised key/);
    expect(() => loadConfig(dir)).not.toThrow(/sk_live/);
  });

  it('refuses a version other than 1', () => {
    refuses('version: 2\n', /version must be 1/);
  });

  it('refuses a config that is not a mapping', () => {
    refuses('- a\n- b\n', /must be a mapping/);
    refuses('hello\n', /must be a mapping/);
    refuses('false\n', /must be a mapping/);
  });

  it('reads an empty config as empty, and still names it', () => {
    expect(loadConfig(dirWith(''))).toEqual({ source: '.egressa.yml' });
  });

  it('refuses a file that is not UTF-8, and names UTF-16', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('suppressions:\n  - {vendor: stripe, reason: x}\n', 'utf16le'),
    ]);
    refuses(utf16, /UTF-16/);
    refuses(Buffer.from([0x72, 0x65, 0x61, 0x73, 0x6f, 0x6e, 0x3a, 0x20, 0xe9, 0x0a]), /UTF-8/);
  });

  it('refuses a symlink that does not resolve, and a directory', () => {
    const dangling = mkdtempSync(join(tmpdir(), 'adq-'));
    symlinkSync(join(dangling, 'missing.yml'), join(dangling, '.egressa.yml'));
    expect(() => loadConfig(dangling)).toThrow(/symlink that does not resolve/);
    const loop = mkdtempSync(join(tmpdir(), 'adq-'));
    symlinkSync(join(loop, '.egressa.yml'), join(loop, '.egressa.yml'));
    expect(() => loadConfig(loop)).toThrow(/symlink that does not resolve/);
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    mkdirSync(join(dir, '.egressa.yml'));
    expect(() => loadConfig(dir)).toThrow(/is a directory/);
  });

  it('refuses an explicit config that is not a mapping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(join(dir, 'hostname'), 'myhost\n');
    expect(() => loadConfig(dir, join(dir, 'hostname'))).toThrow(/must be a mapping/);
  });

  it('refuses a failOn that the CLI would refuse', () => {
    refuses('failOn: loud\n', /failOn must be one of none, note, warning, error/);
  });

  it('refuses an expiry that is not an ISO date, or a time with no zone', () => {
    for (const expires of ['banana 12', '01/02/2027', '2027-02-30', '2027-01-31T10:00', '1']) {
      refuses(entry(`    expires: "${expires}"\n`), /expires must be a date/);
    }
    expect(
      loadConfig(dirWith(entry('    expires: "2027-01-31T10:00Z"\n'))).suppressions,
    ).toHaveLength(1);
    expect(
      loadConfig(dirWith(entry('    expires: "2027-01-31T10:00:00+05:30"\n'))).suppressions,
    ).toHaveLength(1);
  });
});

describe('a date-only expiry', () => {
  it('holds through the whole of that day in UTC', () => {
    const on = (date: string) =>
      result({ suppressions: [{ vendor: 'stripe', reason: 'x', expires: date }] });
    // NOW is 2026-09-06T12:00Z.
    expect(on('2026-09-06').findings[0]?.suppressed).toBe(true);
    expect(on('2026-09-05').findings[0]?.suppressed).toBe(false);
    expect(on('2026-09-06T11:00Z').findings[0]?.suppressed).toBe(false);
  });
});

describe('a suppression that matches nothing says so', () => {
  // Field test 4, E18. `vendor: Stripe` (the id is `stripe`) loaded, matched
  // nothing, and the reviewer believed the risk accepted.
  const warnings = (suppressions: object[], options: object = {}) =>
    scan({
      root: 'fixtures/repos/express-stripe-sendgrid',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      now: NOW,
      includeCallsites: true,
      config: { source: '.egressa.yml', suppressions: suppressions as never },
      ...options,
    })
      .errors.filter((e) => e.file === '.egressa.yml')
      .map((e) => [e.fatal, e.message]);

  it('names a vendor that is not in the knowledge base, with a hint', () => {
    expect(warnings([{ vendor: 'Stripe', reason: 'x' }])).toEqual([
      [
        false,
        'suppression 1 names vendor "Stripe", which is not in the knowledge base (did you mean "stripe"?)',
      ],
    ]);
  });

  it('names a rule that does not exist', () => {
    expect(warnings([{ rule: 'transfer/adequate-egress', reason: 'x' }])).toEqual([
      [false, 'suppression 1 names rule "transfer/adequate-egress", which is not a rule'],
    ]);
  });

  it('says a known vendor matched no finding in this scan', () => {
    expect(warnings([{ vendor: 'sentry', reason: 'x' }])).toEqual([
      [false, 'suppression 1 (vendor sentry) matched no finding in this scan'],
    ]);
  });

  it('says so more carefully when the scan was narrowed', () => {
    const narrowed = warnings([{ vendor: 'sentry', reason: 'x' }], {
      onlyVendor: ['stripe'],
      includeCallsites: false,
    });
    expect(narrowed).toEqual([
      [
        false,
        'suppression 1 (vendor sentry) matched no finding in this scan, which was narrowed (only some vendors were scanned; call sites were not analysed), so it may match in a full scan',
      ],
    ]);
  });

  it('says when an earlier suppression already takes everything it matches', () => {
    expect(
      warnings([
        { vendor: 'stripe', reason: 'x' },
        { rule: 'transfer/adequate-country-egress', reason: 'y' },
      ]),
    ).toEqual([
      [
        false,
        'suppression 2 (rule transfer/adequate-country-egress) matches nothing that suppression 1 does not already take',
      ],
    ]);
  });

  it('says nothing about a suppression that matched', () => {
    expect(warnings([{ vendor: 'stripe', reason: 'x' }])).toEqual([]);
  });
});

describe('a summary cut right after an expired finding', () => {
  // Field test 4, E16. Adjacency alone did not protect the pair: at
  // maxFindings 1 the finding was kept and its reminder cut.
  it('keeps the expiry note with its finding', () => {
    const out = result({
      suppressions: [{ vendor: 'stripe', reason: 'x', expires: '2026-01-01' }],
    });
    const shown = summarise(out, { maxFindings: 1 });
    expect(shown.findings.map((f) => f.ruleId)).toEqual([
      out.findings[0]?.ruleId,
      'config/expired-suppression',
    ]);
    expect(shown.truncated).toBe(false);
    expect(shown.omittedFindings).toBe(0);
  });
});

describe('what the branch review found', () => {
  const dirWith = (content: string | Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(join(dir, '.egressa.yml'), content);
    return dir;
  };
  const entry = (extra: string) => `suppressions:\n  - vendor: stripe\n    reason: x\n${extra}`;
  const problems = (
    suppressions: object[],
    findings = result().findings,
    narrowed: string[] = [],
  ) =>
    suppressionProblems(
      findings,
      { suppressions: suppressions as never },
      new Set(['stripe', 'sentry']),
      narrowed,
    );

  it('does not echo a vendor or rule that is not a plain name', () => {
    // Security: the value reached markdown PR comments and the terminal as written.
    const hostile = 'zz"\n\n## Injected\n\u001b[2J';
    const out = problems([
      { vendor: hostile, reason: 'x' },
      { rule: hostile, reason: 'x' },
    ]);
    expect(out).toEqual([
      'suppression 1 names a vendor that is not in the knowledge base',
      'suppression 2 names a rule that does not exist',
    ]);
  });

  it('lists at most twenty suppression problems, and counts the rest', () => {
    // Performance: 60,001 suppressions produced 59,985 errors on every surface.
    const out = problems(Array.from({ length: 30 }, () => ({ vendor: 'sentry', reason: 'x' })));
    expect(out).toHaveLength(21);
    expect(out.at(-1)).toBe('and 10 more suppressions with a problem');
  });

  it('names the first suppression that already takes a finding', () => {
    const [finding] = result().findings;
    const out = problems([
      { rule: finding?.ruleId, reason: 'a' },
      { vendor: 'stripe', reason: 'b' },
      { vendor: 'stripe', rule: finding?.ruleId, reason: 'c' },
    ]);
    expect(out).toEqual([
      `suppression 2 (vendor stripe) matches nothing that suppression 1 does not already take`,
      `suppression 3 (vendor stripe, rule ${finding?.ruleId}) matches nothing that suppression 1 does not already take`,
    ]);
  });

  it('refuses a config that is not a regular file, which would block the read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    execFileSync('mkfifo', [join(dir, '.egressa.yml')]);
    expect(() => loadConfig(dir)).toThrow(/is not a regular file/);
  });

  it('leaves a root that is not a directory to scan(), which reports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(join(dir, 'afile'), 'x');
    expect(loadConfig(join(dir, 'afile'))).toEqual({});
  });

  it.skipIf(process.getuid?.() === 0)('refuses a config it cannot read', () => {
    const dir = dirWith('version: 1\n');
    chmodSync(join(dir, '.egressa.yml'), 0o000);
    expect(() => loadConfig(dir)).toThrow(/cannot be read \(EACCES\)/);
  });

  it('names a big-endian UTF-16 file too', () => {
    const be = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from('version: 1\n', 'utf16le').swap16(),
    ]);
    expect(() => loadConfig(dirWith(be))).toThrow(/UTF-16/);
  });

  it('accepts version "1" quoted, which YAML habit often writes', () => {
    expect(loadConfig(dirWith('version: "1"\n')).version).toBe('1');
  });

  it('refuses a time or zone out of range, which Date.parse would turn into a permanent suppression', () => {
    for (const expires of [
      '2027-01-31T25:00Z',
      '2027-01-31T24:00Z',
      '2027-01-31T10:60Z',
      '2027-01-31T10:00:60Z',
      '2027-01-31T10:00+24:00',
      '2027-01-31T10:00+05:60',
    ]) {
      expect(() => loadConfig(dirWith(entry(`    expires: "${expires}"\n`))), expires).toThrow(
        /expires must be a date/,
      );
    }
  });

  it('expires at the instant given, not after it', () => {
    const at = (expires: string) =>
      result({ suppressions: [{ vendor: 'stripe', reason: 'x', expires }] }).findings[0]
        ?.suppressed;
    expect(at('2026-09-06T12:00Z')).toBe(false);
    expect(at('2026-09-06T12:01Z')).toBe(true);
  });

  it('treats an expiry it cannot read as expired, so nothing is suppressed for good', () => {
    const out = applySuppressions(
      result().findings,
      {
        suppressions: [{ vendor: 'stripe', reason: 'x', expires: '2027-01-31T25:00Z' }],
      },
      NOW,
    );
    expect(out[0]?.suppressed).toBe(false);
  });
});

describe('every way a scan can be narrowed is named', () => {
  // Red team and testing: a missing reason calls a valid suppression stale.
  const narrowed = (options: object) =>
    scan({
      root: 'fixtures/repos/express-stripe-sendgrid',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      now: NOW,
      includeCallsites: true,
      config: { source: '.egressa.yml', suppressions: [{ vendor: 'sentry', reason: 'x' }] },
      ...options,
    }).errors.map((e) => e.message);
  it.each([
    [{ minConfidence: 'high' }, 'findings below high confidence were dropped'],
    [{ includeDev: false }, 'dev dependencies were skipped'],
    [{ includeManifests: false }, 'manifests were not read'],
    [{ exclude: ['legacy/**'] }, 'the caller excluded paths'],
    [{ assumeAdequacyLapsed: ['US:DPF'] }, 'adequacy decisions were assumed withdrawn'],
    [
      {
        includeTransitive: false,
        config: {
          source: '.egressa.yml',
          includeTransitive: true,
          suppressions: [{ vendor: 'sentry', reason: 'x' }],
        },
      },
      'transitive dependencies were left out',
    ],
  ])('%o', (options, reason) => {
    expect(narrowed(options)).toEqual([expect.stringContaining(reason)]);
  });
});

describe("the summary's errors", () => {
  it('lists twenty and counts the rest', () => {
    const errors = Array.from({ length: 21 }, (_, i) => ({
      file: 'f',
      message: `e${i}`,
      fatal: false,
    }));
    const shown = summarise({ ...result(), errors });
    expect(shown.errors).toHaveLength(20);
    expect(shown.omittedErrors).toBe(1);
  });

  it('lists a fatal error first, so the cut cannot hide why a summary is empty', () => {
    const errors = [
      ...Array.from({ length: 25 }, (_, i) => ({ file: 'f', message: `e${i}`, fatal: false })),
      { file: 'root', message: 'not a readable directory', fatal: true },
    ];
    expect(summarise({ ...result(), errors }).errors[0]?.fatal).toBe(true);
  });
});

describe('what the adversarial review found', () => {
  const dirWith = (content: string | Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-'));
    writeFileSync(join(dir, '.egressa.yml'), content);
    return dir;
  };

  it('refuses an empty vendor, rule or expires, which matched every vendor', () => {
    for (const field of [
      'vendor: ""\n    rule: transfer/third-country-egress',
      'vendor: stripe\n    rule: " "',
      'vendor: stripe\n    expires: ""',
    ]) {
      expect(
        () => loadConfig(dirWith(`suppressions:\n  - ${field}\n    reason: x\n`)),
        field,
      ).toThrow(/is empty/);
    }
  });

  it('never matches every vendor on an empty vendor that reaches applySuppressions', () => {
    const out = applySuppressions(
      result().findings,
      {
        suppressions: [{ vendor: '', rule: result().findings[0]?.ruleId, reason: 'x' }],
      },
      NOW,
    );
    expect(out.every((f) => !f.suppressed)).toBe(true);
  });

  it('refuses a config larger than 8 MB', () => {
    expect(() => loadConfig(dirWith(Buffer.alloc(9 * 1_048_576, 0x20)))).toThrow(
      /larger than 8 MB/,
    );
  });
});
