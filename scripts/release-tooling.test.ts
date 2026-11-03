import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

/**
 * The release scripts run only inside the release workflow, so a regression in
 * them shows up in the first release pull request rather than in `pnpm verify`.
 * Each case runs the real script against a scratch copy of the files it edits.
 */

const ROOT = resolve('.');
const PACKAGES = ['cli', 'core', 'kb-loader', 'mcp'];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'egressa-release-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(script: string, cwd: string, args: string[] = []): { code: number; err: string } {
  try {
    execFileSync('node', [script, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, err: '' };
  } catch (error) {
    const e = error as { status: number; stderr: string };
    return { code: e.status, err: e.stderr ?? '' };
  }
}

/** The files sync-version reads and writes, copied into `dir`. */
function versionTree(dir: string, version: string): void {
  for (const p of PACKAGES) {
    mkdirSync(join(dir, 'packages', p), { recursive: true });
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', p, 'package.json'), 'utf8'));
    pkg.version = version;
    writeFileSync(join(dir, 'packages', p, 'package.json'), JSON.stringify(pkg, null, 2));
  }
  for (const f of [
    'packages/cli/src/version.ts',
    'packages/mcp/src/server.ts',
    '.claude-plugin/plugin.json',
  ]) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
}

describe('sync-version', () => {
  const script = join(ROOT, 'scripts/sync-version.mjs');

  it('carries the package version into VERSION, both literals and the plugin manifest', () => {
    const dir = scratch();
    versionTree(dir, '9.8.7');
    expect(run(script, dir).code).toBe(0);
    expect(readFileSync(join(dir, 'VERSION'), 'utf8')).toBe('9.8.7\n');
    expect(readFileSync(join(dir, 'packages/cli/src/version.ts'), 'utf8')).toContain("'9.8.7'");
    expect(readFileSync(join(dir, 'packages/mcp/src/server.ts'), 'utf8')).toContain("'9.8.7'");
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8')).version).toBe(
      '9.8.7',
    );
  });

  it('refuses when the four packages disagree', () => {
    const dir = scratch();
    versionTree(dir, '1.0.0');
    const core = join(dir, 'packages/core/package.json');
    writeFileSync(
      core,
      JSON.stringify({ ...JSON.parse(readFileSync(core, 'utf8')), version: '1.0.1' }),
    );
    expect(run(script, dir).code).toBe(1);
    expect(existsSync(join(dir, 'VERSION'))).toBe(false);
  });

  it('refuses a version that is not plain semver', () => {
    const dir = scratch();
    versionTree(dir, '1.0.0-beta.1');
    expect(run(script, dir).code).toBe(1);
    expect(existsSync(join(dir, 'VERSION'))).toBe(false);
  });
});

describe('copy-kb, one package at a time', () => {
  /** A copy of the script in a tree of its own, since it resolves paths from itself. */
  function tree(withDist: boolean): string {
    const dir = scratch();
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(ROOT, 'scripts/copy-kb.mjs'), join(dir, 'scripts/copy-kb.mjs'));
    for (const f of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES'])
      cpSync(join(ROOT, f), join(dir, f));
    mkdirSync(join(dir, 'kb'));
    writeFileSync(join(dir, 'kb', 'kb.version'), 'test\n');
    for (const p of PACKAGES) {
      mkdirSync(join(dir, 'packages', p, withDist ? 'dist' : ''), { recursive: true });
    }
    return dir;
  }

  it('refuses a package it does not know, including an inherited key', () => {
    const dir = tree(true);
    for (const name of ['nope', 'constructor']) {
      expect(run(join(dir, 'scripts/copy-kb.mjs'), dir, [name]).code).toBe(1);
    }
  });

  it('refuses to pack a package that has not been built', () => {
    const dir = tree(false);
    const { code, err } = run(join(dir, 'scripts/copy-kb.mjs'), dir, ['cli']);
    expect(code).toBe(1);
    expect(err).toContain('dist is missing');
    expect(existsSync(join(dir, 'packages/cli/LICENSE'))).toBe(false);
  });

  it('copies the licences and the knowledge base into a built package', () => {
    const dir = tree(true);
    expect(run(join(dir, 'scripts/copy-kb.mjs'), dir, ['cli']).code).toBe(0);
    for (const f of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES', 'kb/kb.version']) {
      expect(existsSync(join(dir, 'packages/cli', f))).toBe(true);
    }
    // Only the named package: a parallel pack of another must not be touched.
    expect(existsSync(join(dir, 'packages/mcp/LICENSE'))).toBe(false);
  });

  it('refuses to pack a bundling package without THIRD_PARTY_NOTICES', () => {
    const dir = tree(true);
    rmSync(join(dir, 'THIRD_PARTY_NOTICES'));
    const { code, err } = run(join(dir, 'scripts/copy-kb.mjs'), dir, ['cli']);
    expect(code).toBe(1);
    expect(err).toContain('THIRD_PARTY_NOTICES missing');
    // core inlines nothing, so it does not need the file.
    expect(run(join(dir, 'scripts/copy-kb.mjs'), dir, ['core']).code).toBe(0);
    expect(existsSync(join(dir, 'packages/core/THIRD_PARTY_NOTICES'))).toBe(false);
  });
});

describe('changeset version', () => {
  // changesets/action reads every bumped package's CHANGELOG.md, unguarded, to
  // write the "Version Packages" pull request. With `changelog: false` none was
  // written, so every release after the first failed on ENOENT.
  it('writes a CHANGELOG.md for every package it bumps', () => {
    const dir = scratch();
    versionTree(dir, '0.2.0');
    cpSync(join(ROOT, '.changeset/config.json'), join(dir, '.changeset/config.json'));
    cpSync(join(ROOT, 'pnpm-workspace.yaml'), join(dir, 'pnpm-workspace.yaml'));
    cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(
      join(dir, '.changeset/test-bump.md'),
      "---\n'egressa': patch\n---\n\nA test change.\n",
    );
    execFileSync(join(ROOT, 'node_modules/.bin/changeset'), ['version'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const p of PACKAGES) {
      const changelog = join(dir, 'packages', p, 'CHANGELOG.md');
      expect(existsSync(changelog), changelog).toBe(true);
      expect(readFileSync(changelog, 'utf8')).toContain('0.2.1');
    }
  }, 60_000);
});

describe('the GitHub Action', () => {
  // The SARIF scan honoured a committed .egressa.yml `failOn`, and under
  // `set -e` its exit 1 ended the step before the scan carrying the caller's
  // `fail-on` input ran. Only that second scan may decide the job.
  it('never lets the SARIF scan decide the job result', () => {
    const action = readFileSync('action.yml', 'utf8');
    const sarifScan = action.slice(action.indexOf('--format sarif'));
    const end = sarifScan.search(/\n\s*egressa scan /);
    expect(sarifScan.slice(0, end === -1 ? undefined : end)).toContain('--fail-on none');
  });

  /** The composite steps, in order, split on their `- name:` lines. */
  function steps(): { name: string; body: string }[] {
    const action = readFileSync('action.yml', 'utf8');
    return action
      .split(/\n {4}- name: /)
      .slice(1)
      .map((chunk) => ({ name: chunk.slice(0, chunk.indexOf('\n')), body: chunk }));
  }

  // The scanned repository is untrusted, and the upload used to run whenever a
  // file named egressa.sarif existed in the workspace: a committed file was
  // uploaded when the scan crashed, and a committed directory of that name
  // survived `rm -f`, aborting the step while hashFiles still matched it.
  it('uploads only a SARIF file the scan step wrote outside the checkout', () => {
    const [scan, upload] = steps();
    expect(readFileSync('action.yml', 'utf8')).not.toContain('hashFiles(');
    expect(scan?.body).toMatch(/sarif="\$RUNNER_TEMP\//);
    expect(scan?.body).not.toMatch(/--out "\$GITHUB_WORKSPACE/);
    // The output is set only once the scan has written the file.
    const body = scan?.body ?? '';
    expect(body.indexOf('echo "sarif=$sarif" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(
      body.indexOf('--format sarif'),
    );
    expect(upload?.body).toContain("steps.scan.outputs.sarif != ''");
    expect(upload?.body).toContain('sarif_file: ${{ steps.scan.outputs.sarif }}');
  });

  // With the fail-on scan inside the Scan step, a tripped gate failed that
  // step, and the upload then relied on the outputs of a failed step.
  it('applies fail-on in its own step, after the upload, so the upload never follows a failure', () => {
    const names = steps().map((s) => s.name);
    expect(names).toEqual(['Scan', 'Upload SARIF', 'Check fail-on']);
    const [scan, upload, gate] = steps();
    expect(scan?.body).not.toContain('EGRESSA_FAIL_ON');
    expect(upload?.body).not.toContain('always()');
    expect(gate?.body).toContain('--fail-on "$EGRESSA_FAIL_ON"');
    expect(gate?.body).toContain('cd "$RUNNER_TEMP"');
    expect(gate?.body).toContain('--registry=https://registry.npmjs.org/');
  });
});
