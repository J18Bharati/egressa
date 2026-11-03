import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FINDINGS_SCHEMA_VERSION, scan } from '@egressa/core';
import { describe, expect, it } from 'vitest';
import { exitCodeFor } from './commands/scan.js';
import { EXIT } from './exit-codes.js';
import { formatHuman } from './format/human.js';
import { formatMarkdown } from './format/markdown.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const result = () =>
  scan({
    root: 'fixtures/repos/express-stripe-sendgrid',
    toolVersion: '0.1.0',
    kbPath: 'kb',
    now: NOW,
  });

describe('human output', () => {
  it('prints no control character from a warning the scanned repository wrote', () => {
    // Security: raw escapes cleared the screen and planted an OSC 8 link.
    const text = formatHuman(
      {
        ...result(),
        errors: [
          { file: 'a\u001b]8;;https://evil\u0007.yml', message: 'm\u001b[2J\nx', fatal: false },
        ],
      },
      { color: false },
    );
    const warning = text.split('\n').filter((line) => line.startsWith('warning:'));
    expect(warning).toHaveLength(1);
    const control = Array.from(warning[0] ?? '').filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
    expect(control).toEqual([]);
  });

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

  it('marks a region the vendor map does not know, and reads only the provider’s own', () => {
    // The tag nested in default_tags used to become a second finding titled
    // "(emea)"; a typo in the real region rendered exactly like a resolved one.
    const root = mkdtempSync(join(tmpdir(), 'egressa-unmapped-'));
    writeFileSync(
      join(root, 'main.tf'),
      'provider "aws" {\n  default_tags {\n    tags = { region = "emea" }\n  }\n  region = "eu-wset-1"\n}\n',
    );
    const text = formatHuman(scan({ root, toolVersion: '0.1.0', kbPath: 'kb', now: NOW }), {
      color: false,
    });
    expect(text).toContain('Amazon Web Services, Inc. (eu-wset-1 [unmapped])');
    expect(text).not.toContain('emea');
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

  it('does not render the unresolved reason as though it were a vendor name', () => {
    // Every finding here has vendor: null and evidence[].matchedOn equal to
    // the diagnostic sentence explaining why (see toHit() in
    // callsites/index.ts). Promoting that sentence into the header used to
    // make it read like a company. The reason must still survive somewhere.
    const unresolved = scan({
      root: 'fixtures/repos/unresolvable-hosts',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      includeCallsites: true,
      now: NOW,
    });
    const text = formatHuman(unresolved, { color: false });
    const headerLines = text.split('\n').filter((line) => /^[!xi] /.test(line));
    expect(headerLines.length).toBeGreaterThan(0);
    for (const line of headerLines) {
      expect(line).toContain('Unrecognised destination');
      expect(line).not.toContain('interpolated value');
      expect(line).not.toContain('declared more than once');
      expect(line).not.toContain('environment variable');
    }
    // The reason is still present, just in the evidence line rather than the header.
    expect(text).toContain(
      'host is completed by an interpolated value and cannot be resolved statically',
    );
  });
});

describe('markdown output', () => {
  it('carries the full disclaimer and a per-vendor table', () => {
    const md = formatMarkdown(result());
    expect(md).toContain('does not assess or certify GDPR compliance');
    expect(md).toContain('| Vendor | Reason | Processing | EU region | Rule | Confidence |');
    expect(md).toContain('Stripe, LLC');
  });

  it("lists the scan's warnings, which it used to leave out", () => {
    const md = formatMarkdown({
      ...result(),
      errors: [{ file: '.egressa.yml', message: 'suppression 1 matched no finding', fatal: false }],
    });
    expect(md).toContain('### Warnings');
    expect(md).toContain('- `.egressa.yml`: suppression 1 matched no finding');
    expect(md.indexOf('### Warnings')).toBeLessThan(md.indexOf('does not assess or certify'));
  });

  it('cannot be restructured or styled by a warning from the scanned repository', () => {
    // Security: a path or message is repository content, and markdown output
    // is posted as a PR comment.
    const md = formatMarkdown({
      ...result(),
      errors: [
        {
          file: 'a`b\n## x.txt',
          message: 'm\n\n## Injected\n![p](https://attacker.example/px.png)\u001b[2J',
          fatal: false,
        },
      ],
    });
    const warning = md.split('### Warnings')[1]?.split('---')[0] ?? '';
    expect(warning).not.toMatch(/\n##|!\[/);
    expect(warning).not.toContain(String.fromCharCode(27));
    expect(warning.trim().split('\n')).toHaveLength(1);
  });

  it('lists at most twenty warnings, and never mentions or links from one', () => {
    const errors = Array.from({ length: 25 }, (_, i) => ({
      file: `packages/@org/team/www.example.com/${i}.txt`,
      message: 'ping @org/team',
      fatal: false,
    }));
    const md = formatMarkdown({ ...result(), errors });
    const warning = md.split('### Warnings')[1]?.split('---')[0] ?? '';
    expect(
      warning
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('- `')),
    ).toHaveLength(20);
    expect(warning).toContain('and 5 more');
    // A code span renders literally; outside one, an @ must be escaped.
    expect(warning.replace(/`[^`]*`/g, '')).not.toMatch(/(^|[^\\])@org/);
  });

  it('says how many findings it withheld when truncating', () => {
    const full = result();
    expect(full.findings.length).toBeGreaterThan(0);
    const md = formatMarkdown(full, { maxFindings: 0 });
    expect(md).toContain(`${full.findings.length} further finding(s) not shown`);
  });

  it('keeps the unresolved reason out of the Vendor column but visible in its own column', () => {
    const unresolved = scan({
      root: 'fixtures/repos/unresolvable-hosts',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      includeCallsites: true,
      now: NOW,
    });
    const md = formatMarkdown(unresolved);
    const tableLines = md
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('| ') && !line.startsWith('| Vendor') && !line.startsWith('| ---'),
      );
    expect(tableLines.length).toBe(3);
    for (const line of tableLines) {
      const vendorCell = line.split('|')[1]?.trim();
      expect(vendorCell).toBe('Unrecognised destination');
    }
    // The reason is still present -- it moved to its own column, not to the heading.
    expect(md).toContain(
      '| Unrecognised destination | host is completed by an interpolated value and cannot be resolved statically |',
    );
    expect(md).not.toContain('### host is completed by an interpolated value');
    expect(md).toContain('### Unrecognised destination');
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

  /** Like run(), but keeps stderr, so a usage error is checked for what it says. */
  const runErr = (args: string[]) => {
    try {
      execFileSync('npx', ['tsx', 'packages/cli/src/cli.ts', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stderr: '' };
    } catch (error) {
      const e = error as { status: number; stderr: string };
      return { code: e.status, stderr: e.stderr ?? '' };
    }
  };

  it('refuses a mistyped flag as a usage error instead of scanning everything', () => {
    const { code, stderr } = runErr(['scan', 'fixtures/repos/clean-eu-only', '--exlude', 'x/**']);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain('unknown option --exlude');
  });

  it('refuses a mistyped flag with no subcommand too', () => {
    const { code, stderr } = runErr(['fixtures/repos/clean-eu-only', '--failOn', 'note']);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain('--failOn');
  });

  it('refuses a negated exclude glob, which discovery cannot honour', () => {
    const { code, stderr } = runErr(['scan', 'fixtures/repos/clean-eu-only', '--exclude=!x/**']);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain('cannot be negated');
  });

  describe('an exclude list in .egressa.yml', () => {
    const repo = (config: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'egressa-cfg-'));
      writeFileSync(join(dir, '.egressa.yml'), config);
      return dir;
    };

    it('refuses a negated glob there as well', () => {
      const { code, stderr } = runErr(['scan', repo('exclude:\n  - "!legacy/**"\n')]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain('cannot be negated');
    });

    it('refuses an entry YAML read as a number, instead of crashing', () => {
      const { code, stderr } = runErr(['scan', repo('exclude:\n  - legacy/**\n  - 2024\n')]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain('must be glob strings');
    });

    it('reads a single glob as one glob, not a list of characters', () => {
      const dir = repo('exclude: legacy/**\n');
      mkdirSync(join(dir, 'legacy'));
      writeFileSync(join(dir, 'legacy', 'pay.ts'), "fetch('https://api.stripe.com/v1/x');\n");
      const { code, stdout } = run(['scan', dir, '--format', 'json']);
      expect(code).toBe(EXIT.CLEAN);
      const doc = JSON.parse(stdout);
      expect(doc.scan.exclude).toEqual(['legacy/**']);
      expect(doc.summary.findingCount).toBe(0);
    });

    it('reports malformed YAML as a usage error, naming the file', () => {
      const { code, stderr } = runErr(['scan', repo('exclude: [legacy/**\n')]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain('.egressa.yml');
    });

    it('names the file, not the flag, when failOn in it is not a level', () => {
      const { code, stderr } = runErr(['scan', repo('failOn: loud\n')]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain('.egressa.yml: failOn must be one of');
      expect(stderr).not.toContain('--fail-on');
    });

    it('refuses an explicit --config that is not a mapping, rather than scanning without it', () => {
      const dir = repo('version: 1\n');
      writeFileSync(join(dir, 'hostname'), 'myhost\n');
      const { code, stderr } = runErr(['scan', dir, '--config', join(dir, 'hostname')]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain('must be a mapping');
    });

    it('refuses a misspelled expires, which used to leave the suppression permanent', () => {
      const { code, stderr } = runErr([
        'scan',
        repo('suppressions:\n  - {vendor: stripe, reason: x, expiry: "2020-01-01"}\n'),
      ]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain('did you mean "expires"');
    });

    it('reports a suppressions entry that is not a list as a usage error', () => {
      // It exited 1, the findings code, after the config moved into core.
      const { code, stderr } = runErr(['scan', repo('suppressions: nope\n')]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain('suppressions must be a list');
    });

    it('lets --no-include-transitive override a config that turns it on', () => {
      // @supabase/auth-js is detected transitively, so the setting is visible.
      const dir = repo('includeTransitive: true\n');
      writeFileSync(join(dir, 'package.json'), '{"name":"x","dependencies":{"foo":"1"}}');
      writeFileSync(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'x', dependencies: { foo: '1' } },
            'node_modules/foo': { version: '1' },
            'node_modules/@supabase/auth-js': { version: '2' },
          },
        }),
      );
      const vendors = (extra: string[]) =>
        JSON.parse(
          run(['scan', dir, '--kb', 'kb', '--format', 'json', ...extra]).stdout,
        ).findings.map((f: { vendor: { id: string } | null }) => f.vendor?.id);
      expect(vendors([])).toEqual(['supabase']);
      expect(vendors(['--no-include-transitive'])).toEqual([]);
    });

    it('warns in human output about a suppression that matched nothing, without changing the exit code', () => {
      const dir = repo('suppressions:\n  - {vendor: Stripe, reason: accepted}\n');
      writeFileSync(join(dir, 'pay.ts'), "fetch('https://api.stripe.com/v1/charges');\n");
      const { code, stdout } = run(['scan', dir, '--kb', 'kb']);
      expect(code).toBe(EXIT.CLEAN);
      expect(stdout).toContain(
        'warning: .egressa.yml: suppression 1 names vendor "Stripe", which is not in the knowledge base (did you mean "stripe"?)',
      );
    });

    it('reports a suppression with no reason as a usage error', () => {
      const { code, stderr } = runErr([
        'scan',
        repo('suppressions:\n  - vendor: stripe\n    reason: ""\n'),
      ]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr).toContain('must say why');
    });
  });

  describe('a suppression in .egressa.yml and --fail-on', () => {
    // The CI gate's meaning. Suppressions used to be applied by the CLI just
    // before the exit code was chosen; they are now applied inside scan(), and
    // these pin that the gate still reads them the same way.
    const stripeRepo = (config: string | null) => {
      const dir = mkdtempSync(join(tmpdir(), 'egressa-gate-'));
      writeFileSync(join(dir, 'pay.ts'), "fetch('https://api.stripe.com/v1/charges');\n");
      if (config !== null) writeFileSync(join(dir, '.egressa.yml'), config);
      return dir;
    };
    const suppress = (expires: string) =>
      `suppressions:\n  - vendor: stripe\n    reason: SCCs signed, PRIV-1\n    expires: "${expires}"\n`;

    it('does not fail on a suppressed finding', () => {
      const dir = stripeRepo(suppress('2999-01-01'));
      expect(run(['scan', dir, '--kb', 'kb', '--fail-on', 'note', '--quiet']).code).toBe(
        EXIT.CLEAN,
      );
    });

    it('fails on the same finding with no suppression', () => {
      const dir = stripeRepo(null);
      expect(run(['scan', dir, '--kb', 'kb', '--fail-on', 'note', '--quiet']).code).toBe(
        EXIT.FINDINGS,
      );
    });

    it('fails again once the suppression expires, with the note after its finding', () => {
      const dir = stripeRepo(suppress('2000-01-01'));
      expect(run(['scan', dir, '--kb', 'kb', '--fail-on', 'note', '--quiet']).code).toBe(
        EXIT.FINDINGS,
      );
      const doc = JSON.parse(run(['scan', dir, '--kb', 'kb', '--format', 'json']).stdout);
      const ids = doc.findings.map((f: { ruleId: string }) => f.ruleId);
      const at = ids.indexOf('config/expired-suppression');
      expect(at).toBeGreaterThan(0);
      expect(doc.findings[at - 1].vendor.id).toBe('stripe');
      expect(doc.findings[at - 1].suppressed).toBe(false);
    });

    it('shows a suppressed finding in SARIF as dismissed, with its reason', () => {
      const dir = stripeRepo(suppress('2999-01-01'));
      const sarif = JSON.parse(run(['scan', dir, '--kb', 'kb', '--format', 'sarif']).stdout);
      const dismissed = sarif.runs[0].results.filter(
        (r: { suppressions?: unknown[] }) => (r.suppressions ?? []).length > 0,
      );
      expect(dismissed).toHaveLength(1);
      expect(JSON.stringify(dismissed[0].suppressions)).toContain('PRIV-1');
    });
  });

  it('writes --out=- to stdout, not to a file named -', () => {
    // Run from an empty directory with absolute paths, so a regression leaves
    // its stray file there rather than in the repository.
    const cwd = mkdtempSync(join(tmpdir(), 'egressa-out-'));
    const repo = process.cwd();
    const stdout = execFileSync(
      join(repo, 'node_modules/.bin/tsx'),
      [
        // The repository's tsconfig maps @egressa/* to source; without it tsx,
        // started outside the repository, loads whatever was last built.
        '--tsconfig',
        join(repo, 'tsconfig.json'),
        join(repo, 'packages/cli/src/cli.ts'),
        'scan',
        join(repo, 'fixtures/repos/express-stripe-sendgrid'),
        '--kb',
        join(repo, 'kb'),
        '--format',
        'json',
        '--out=-',
      ],
      { cwd, encoding: 'utf8' },
    );
    expect(JSON.parse(stdout).schemaVersion).toBe(FINDINGS_SCHEMA_VERSION);
    expect(existsSync(join(cwd, '-'))).toBe(false);
  });

  it('answers --version with the tool version', () => {
    // It was in PASS_THROUGH and exited 1 with "No version specified", because
    // the root command's meta carried no version for citty to print.
    //
    // citty prints it through consola, which silences itself when the
    // environment says a test runner is active -- and the child inherits
    // vitest's. Without these removed the version is printed nowhere.
    const { NODE_ENV, TEST, VITEST, ...env } = process.env;
    for (const flag of ['--version', '-v']) {
      const stdout = execFileSync('npx', ['tsx', 'packages/cli/src/cli.ts', flag], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      expect({ flag, out: stdout.trim() }).toEqual({
        flag,
        out: readFileSync('VERSION', 'utf8').trim(),
      });
    }
  });

  it('explains a rule without needing a scan', () => {
    const { stdout } = run(['explain', 'transfer/third-country-egress']);
    expect(stdout).toContain('Chapter V');
    expect(stdout).toContain('does not assess or certify GDPR compliance');
  });

  it('refuses a rule id that is only an inherited object key', () => {
    // `RULES` is an object literal, so `RULES['constructor']` is a function and
    // read as a rule: this exited 0 printing "Default level: undefined".
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect(run(['explain', id]).code).toBe(2);
    }
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

  it('resolves a vendor by PyPI package name', () => {
    // It used to answer "No knowledge base entry" for a vendor the knowledge
    // base carries, because only npm was tried.
    const { stdout } = run(['vendors', 'show', 'boto3', '--kb', 'kb']);
    expect(JSON.parse(stdout).id).toBe('aws');
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

describe('--exclude scopes discovery', () => {
  const json = (args: string[]) => {
    const stdout = execFileSync('npx', ['tsx', 'packages/cli/src/cli.ts', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout) as ReturnType<typeof scan>;
  };

  // fixtures/repos/nextjs-analytics-heavy has a google-analytics finding backed
  // by exactly one signal: the fetch() call in src/analytics.ts. It has no
  // dependency entry, so excluding that file is the one way to make it
  // disappear entirely rather than merely lose a signal.
  const base = ['scan', 'fixtures/repos/nextjs-analytics-heavy', '--format', 'json', '--kb', 'kb'];

  it('drops findings sourced only from the excluded path', () => {
    const on = json(base);
    expect(on.summary.findingCount).toBe(3);
    expect(on.findings.some((f) => f.vendor?.id === 'google-analytics')).toBe(true);
    // An unexcluded scan must not carry the field at all -- a document that
    // always has `scan.exclude: []` gives a reader nothing to grep for.
    expect(on.scan.exclude).toBeUndefined();

    const off = json([...base, '--exclude', 'src/analytics.ts']);
    expect(off.summary.findingCount).toBe(2);
    expect(off.findings.some((f) => f.vendor?.id === 'google-analytics')).toBe(false);
    // openai and sentry are still declared in package.json, so their manifest
    // signal survives losing the call site -- --exclude removes what it
    // names, not the vendor everywhere it's mentioned.
    expect(off.findings.some((f) => f.vendor?.id === 'openai')).toBe(true);
    expect(off.findings.some((f) => f.vendor?.id === 'sentry')).toBe(true);
    // A narrowed scan says so in the document itself -- that is the whole
    // point of this task, not just what it excluded.
    expect(off.scan.exclude).toEqual(['src/analytics.ts']);
  });

  it('accepts the flag more than once and applies every glob', () => {
    // Repeating --exclude has to collect into an array rather than the second
    // occurrence silently overwriting the first (citty's own array handling
    // for a repeated string flag, exercised end to end here).
    const off = json([...base, '--exclude', 'src/analytics.ts', '--exclude', 'package.json']);
    // Losing package.json as well removes the dependency signal that kept
    // openai and sentry alive in the single-flag case above.
    expect(off.summary.findingCount).toBe(0);
    expect(off.scan.exclude).toEqual(['src/analytics.ts', 'package.json']);
  });

  it('unions the flag with .egressa.yml rather than one replacing the other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-exclude-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'package.json'),
      readFileSync('fixtures/repos/nextjs-analytics-heavy/package.json', 'utf8'),
    );
    writeFileSync(
      join(dir, 'src', 'analytics.ts'),
      readFileSync('fixtures/repos/nextjs-analytics-heavy/src/analytics.ts', 'utf8'),
    );
    // The config excludes the source file (dropping google-analytics, which
    // has no other signal); the flag separately excludes the manifest
    // (dropping the dependency signal that keeps openai and sentry alive).
    // If either exclude silently replaced the other, one vendor would remain.
    writeFileSync(join(dir, '.egressa.yml'), 'version: 1\nexclude: ["src/analytics.ts"]\n');

    const withConfigOnly = json(['scan', dir, '--format', 'json', '--kb', 'kb']);
    expect(withConfigOnly.summary.findingCount).toBe(2);

    const withBoth = json([
      'scan',
      dir,
      '--format',
      'json',
      '--kb',
      'kb',
      '--exclude',
      'package.json',
    ]);
    expect(withBoth.summary.findingCount).toBe(0);
    // The recorded list is the union actually applied -- the config's glob
    // and the flag's, not just one of the two sources.
    expect(withBoth.scan.exclude).toEqual(['src/analytics.ts', 'package.json']);
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

describe('the infrastructure flag changes the scan', () => {
  it('--no-infrastructure drops the regions declared in deployment config', () => {
    const withInfra = scan({
      root: 'fixtures/repos/regional-multi',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      now: NOW,
    });
    const without = scan({
      root: 'fixtures/repos/regional-multi',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      now: NOW,
      includeInfrastructure: false,
    });
    const infraSignals = (r: typeof withInfra) =>
      r.findings.flatMap((f) => f.signals).filter((s) => s.kind === 'infrastructure').length;
    expect(infraSignals(withInfra)).toBeGreaterThan(0);
    expect(infraSignals(without)).toBe(0);
  });
});

describe('a reference is not rendered like a call site', () => {
  // `new URL(...)` and `new Request(...)` name a vendor without proving a
  // call happened (docs/LIMITATIONS.md, "A constructed URL is a reference,
  // not a call"). No fixture repo has one, so build a minimal one here: a
  // single `new URL()` naming Stripe, with no `fetch`/client-constructor
  // call site and no dependency on the `stripe` package, so the finding's
  // evidence is entirely `reference`.
  const referenceOnlyResult = () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-reference-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'reference-only', version: '1.0.0', private: true }),
    );
    writeFileSync(
      join(dir, 'src', 'index.ts'),
      "const u = new URL('https://api.stripe.com/v1');\n",
    );
    return scan({
      root: dir,
      toolVersion: '0.1.0',
      kbPath: 'kb',
      includeCallsites: true,
      now: NOW,
    });
  };

  /**
   * The case `isReferenceOnly` exists for. A dependency signal outranks a
   * reference in `byStrength`, so it sorts first -- and checking `evidence[0]`
   * would then call this finding a call site when nothing observed a call.
   * The single-signal case above would pass either way, so it does not cover
   * the reason the function reads the whole array.
   */
  it('is still reference-only when a dependency signal sorts ahead of the reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adq-reference-mixed-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'mixed', version: '1.0.0', dependencies: { stripe: '^14.0.0' } }),
    );
    // Names the vendor twice, calls it never.
    writeFileSync(
      join(dir, 'src', 'index.ts'),
      "const u = new URL('https://api.stripe.com/v1');\n",
    );
    const result = scan({
      root: dir,
      toolVersion: '0.1.0',
      kbPath: 'kb',
      includeCallsites: true,
      now: NOW,
    });

    const finding = result.findings.find((f) => f.vendor?.id === 'stripe');
    const kinds = finding?.evidence.map((e) => e.kind) ?? [];
    expect(kinds).toContain('dependency');
    expect(kinds).toContain('reference');
    expect(kinds).not.toContain('callsite');
    // The dependency sorts first, which is exactly what evidence[0] would trip on.
    expect(finding?.evidence[0]?.kind).toBe('dependency');
    expect(formatHuman(result, { color: false })).toContain('named, not called');
  });

  it('has evidence of kind reference and only reference', () => {
    const r = referenceOnlyResult();
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.vendor?.id).toBe('stripe');
    expect(r.findings[0]?.evidence.map((e) => e.kind)).toEqual(['reference']);
  });

  it('is marked distinctly from a call-site finding in human output', () => {
    const referenceText = formatHuman(referenceOnlyResult(), { color: false });
    // express-stripe-sendgrid has an actual `fetch()` call site for Stripe
    // (src/pay.ts), so its evidence is not reference-only.
    const callsiteResult = scan({
      root: 'fixtures/repos/express-stripe-sendgrid',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      includeCallsites: true,
      now: NOW,
    });
    expect(callsiteResult.findings[0]?.evidence.some((e) => e.kind === 'callsite')).toBe(true);
    const callsiteText = formatHuman(callsiteResult, { color: false });

    expect(referenceText).toContain('[reference]');
    expect(referenceText).toContain('[named, not called]');
    expect(callsiteText).not.toContain('[reference]');
    expect(callsiteText).not.toContain('[named, not called]');
  });
});

describe('exit codes for a kb/stale-entry note', () => {
  // A stale knowledge base entry is a note, so it can fail CI only for a team
  // that opted into --fail-on note. Anything stricter would break every
  // pipeline the day an entry crossed the threshold, with no code change.
  const result = scan({
    root: 'fixtures/repos/express-stripe-sendgrid',
    toolVersion: '0.1.0',
    kbPath: 'kb',
    now: new Date('2027-09-06T12:00:00.000Z'),
  });
  const notesOnly = {
    ...result,
    findings: result.findings.filter((f) => f.ruleId === 'kb/stale-entry'),
  };

  it.each([
    ['none', 0],
    ['error', 0],
    ['warning', 0],
    ['note', 1],
  ] as const)('--fail-on %s exits %i', (level, code) => {
    expect(notesOnly.findings.length).toBeGreaterThan(0);
    expect(exitCodeFor(notesOnly, level)).toBe(code);
  });
});

describe('egressa facts check', () => {
  const run = (args: string[]) => {
    try {
      const stdout = execFileSync('npx', ['tsx', 'packages/cli/src/cli.ts', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
  // The command judges expiry against the real clock, so the reading is dated today.
  const today = new Date().toISOString().slice(0, 10);
  const repo = (text: string) => {
    const root = mkdtempSync(join(tmpdir(), 'egressa-facts-cli-'));
    mkdirSync(join(root, '.egressa'));
    writeFileSync(join(root, '.egressa', 'facts.json'), text);
    return root;
  };
  const fact = (vendor: string) => ({
    vendor,
    fact: 'dpf',
    value: {
      observedStatus: 'Active',
      organizationName: 'Notion Labs, Inc.',
      participantUrl: 'https://www.dataprivacyframework.gov/participant/6134',
    },
    source: { url: 'https://www.dataprivacyframework.gov/participant/6134', retrievedAt: today },
    verifiedBy: 'A Person',
  });

  it('says so and exits 0 when there is no file', () => {
    const { code, stdout } = run(['facts', 'check', mkdtempSync(join(tmpdir(), 'egressa-'))]);
    expect(code).toBe(EXIT.CLEAN);
    expect(stdout).toMatch(/No \.egressa\/facts\.json/);
  });

  it('lists each item with its state, and exits 1 when one is rejected', () => {
    const root = repo(JSON.stringify({ version: 1, facts: [fact('notion'), fact('nobody')] }));
    const { code, stdout } = run(['facts', 'check', root]);
    expect(code).toBe(EXIT.FINDINGS);
    // Notion's shipped record is the qualified status, so an Active reading loosens it.
    expect(stdout).toMatch(/1 loosening-not-trusted, 1 rejected/);
    expect(stdout).toMatch(/facts\[0\]\s+notion\s+dpf\s+loosening-not-trusted/);
    expect(stdout).toMatch(/facts\[1\]\s+nobody\s+dpf\s+rejected/);
  });

  it('exits 0 when every item is current, and prints JSON on request', () => {
    const root = repo(JSON.stringify({ version: 1, facts: [fact('notion')] }));
    const { code, stdout } = run(['facts', 'check', root, '--json']);
    expect(code).toBe(EXIT.CLEAN);
    expect(JSON.parse(stdout).items[0]).toMatchObject({
      at: 'facts[0]',
      state: 'loosening-not-trusted',
    });
    const trusted = run(['facts', 'check', root, '--json', '--trust-facts']);
    expect(JSON.parse(trusted.stdout).items[0]).toMatchObject({
      state: 'applied',
      effect: 'loosens',
    });
  });

  it('is a usage error, exit 2, when the root is not a directory', () => {
    const { code } = run(['facts', 'check', join(tmpdir(), 'egressa-no-such-dir-x7')]);
    expect(code).toBe(EXIT.USAGE);
  });

  it('never prints a local entry in --json, only its state and provenance', () => {
    const local = JSON.parse(readFileSync('fixtures/repos/overlay-dpf/.egressa/facts.json', 'utf8'))
      .localVendors[0];
    local.retrievedAt = today;
    const root = repo(JSON.stringify({ version: 1, localVendors: [local] }));
    const { stdout } = run(['facts', 'check', root, '--json']);
    expect(JSON.parse(stdout).items[0]).toMatchObject({ kind: 'local-entry', state: 'applied' });
    expect(stdout).not.toContain('"entry"');
    expect(stdout).not.toContain('acme-geo-fixture.net');
  });

  it('makes scan exit 2 on a facts file it cannot read, and applies --trust-facts', () => {
    const bad = run(['scan', repo('{"version": 1,}'), '--format', 'json']);
    expect(bad.code).toBe(EXIT.USAGE);

    const root = repo(JSON.stringify({ version: 1, facts: [fact('notion')] }));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'x',
        version: '1.0.0',
        dependencies: { '@notionhq/client': '2.0.0' },
      }),
    );
    const notion = (args: string[]) =>
      (
        JSON.parse(run(['scan', root, '--format', 'json', ...args]).stdout) as {
          findings: { ruleId: string; vendor: { id: string } | null }[];
        }
      ).findings.find((f) => f.vendor?.id === 'notion')?.ruleId;
    expect(notion([])).toBe('transfer/third-country-egress-eu-region-available');
    expect(notion(['--trust-facts'])).toBe('transfer/adequate-country-egress');
  });

  it('is a usage error, exit 2, when the file is not a facts document', () => {
    const { code, stderr } = run(['facts', 'check', repo('{"version": 1,}')]);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toMatch(/\.egressa\/facts\.json: not valid JSON/);
  });
});

describe('schema command', () => {
  // Run from outside the checkout: the command used to read `schemas/` and
  // `kb/schema/` relative to the working directory, so it failed anywhere else.
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const cli = join(process.cwd(), 'packages', 'cli', 'src', 'cli.ts');
  const elsewhere = mkdtempSync(join(tmpdir(), 'egressa-schema-'));
  const run = (args: string[]) => {
    try {
      // The root tsconfig is named, since tsx finds it from the working
      // directory and its paths are what point the packages at source.
      const tsconfig = join(process.cwd(), 'tsconfig.json');
      const stdout = execFileSync(tsx, ['--tsconfig', tsconfig, cli, ...args], {
        cwd: elsewhere,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout };
    } catch (error) {
      const e = error as { status: number; stdout: string };
      return { code: e.status, stdout: e.stdout ?? '' };
    }
  };
  const source = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

  it.each([
    ['findings', `schemas/findings-${FINDINGS_SCHEMA_VERSION}.json`],
    ['vendor', 'kb/schema/vendor-1.0.0.json'],
    ['facts', 'kb/schema/facts-1.0.0.json'],
  ])('prints the %s schema it shipped with, from any directory', (which, path) => {
    const { code, stdout } = run(['schema', which]);
    expect(code).toBe(EXIT.CLEAN);
    expect(JSON.parse(stdout)).toEqual(source(path));
  });

  it('is a usage error for a schema it does not have', () => {
    expect(run(['schema', 'nope']).code).toBe(EXIT.USAGE);
  });
});
