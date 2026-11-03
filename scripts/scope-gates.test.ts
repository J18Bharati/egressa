import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `scope.sh` decides which specialists the privacy review dispatches. A gate that
 * reads `false` when it should read `true` is silent: the script still prints a
 * well-formed block ending `SCOPE_END: ok`, and the review reports nothing to
 * look at on a repository full of things to look at.
 *
 * Two of those silent modes are covered here.
 *
 * 1. Size. Every gate used to end in `grep -q`, which exits at its first match
 *    and closes the pipe under the `printf` still writing the file list. The
 *    writer takes SIGPIPE, `pipefail` promotes 141 to the pipeline status, and
 *    the gate reads `false` -- but only once the list is larger than a pipe
 *    buffer, which no fixture in this repository was. The large-tree cases below
 *    are therefore generated, not committed, and the small-tree case beside each
 *    one is what makes the size dependence visible rather than just "it works".
 *
 * 2. Comments. The tracker conjunction is described in SKILL.md as the least
 *    arguable observation this review makes, so a commented-out placeholder
 *    must not raise it.
 */

const SCOPE = resolve('skill/privacy-review/scripts/scope.sh');

// Comfortably past the 64 KiB Linux pipe buffer once joined with newlines:
// the paths below run about 55 bytes each, so 1,800 of them is ~99 KiB.
const BIG = 1800;

interface Run {
  lines: Record<string, string>;
  degraded: string[];
  stdout: string;
  code: number;
}

const runScope = (cwd: string, env: NodeJS.ProcessEnv = {}): Run => {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('bash', [SCOPE, '--repo'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const e = error as { status: number; stdout?: string };
    code = e.status;
    stdout = e.stdout ?? '';
  }
  const lines: Record<string, string> = {};
  const degraded: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([A-Z_]+): (.*)$/.exec(line);
    if (!m?.[1]) continue;
    const value = m[2] ?? '';
    if (m[1] === 'SCOPE_DEGRADED') degraded.push(value);
    else lines[m[1]] = value;
  }
  return { lines, degraded, stdout, code };
};

/**
 * A `grep` that fails only for one flag form and otherwise delegates to the
 * real one. The real path is resolved here rather than hardcoded: grep is not
 * at /usr/bin on every system, and a shim that cannot find it would fail these
 * tests for a reason unrelated to what they check.
 */
const REAL_GREP = execFileSync('sh', ['-c', 'command -v grep'], { encoding: 'utf8' }).trim();
const grepShim = (flag: string) =>
  `#!/bin/sh\nfor a in "$@"; do case "$a" in ${flag}) exit 2 ;; esac; done\nexec ${REAL_GREP} "$@"\n`;

// Every scratch tree is removed after the file runs; some hold FIFOs, and
// leaving them used to accumulate thousands of directories in the temp dir.
const scratchRoots: string[] = [];
const scratch = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `egressa-scope-${tag}-`));
  scratchRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

const plant = (root: string, rel: string, content: string) => {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
};

/**
 * Fills `root` with `count` source files whose joined path list exceeds a pipe
 * buffer. Every file carries the payload, so the gate's `grep` matches in its
 * first batch -- which is what used to close the pipe early.
 */
const fill = (root: string, count: number, payload: string) => {
  for (let i = 0; i < count; i++) {
    const dir = `src/generated/module-${String(i).padStart(5, '0')}/internal`;
    plant(root, `${dir}/component-${String(i).padStart(5, '0')}.ts`, payload);
  }
};

describe('a content gate does not depend on the size of the file list', () => {
  it('reads true on a small tree', () => {
    const root = scratch('small');
    plant(root, 'package.json', '{"name":"small","private":true}\n');
    fill(root, 3, "export const go = () => { console.log('hello'); };\n");

    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_LOGGING).toBe('true');
  });

  it('reads true on a tree whose file list exceeds one pipe buffer', () => {
    const root = scratch('big');
    plant(root, 'package.json', '{"name":"big","private":true}\n');
    fill(root, BIG, "export const go = () => { console.log('hello'); };\n");

    const run = runScope(root);
    // Guard the guard: if this is under 64 KiB the case proves nothing.
    const listBytes = Number(run.lines.CODE_FILES) * 55;
    expect(listBytes).toBeGreaterThan(64 * 1024);

    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_LOGGING).toBe('true');
  });

  it('reads the path and manifest gates on a large tree too', () => {
    const root = scratch('bigmix');
    plant(root, 'package.json', '{"name":"big","dependencies":{"posthog-js":"^1.0.0"}}\n');
    fill(root, BIG, "export const go = () => { console.log('hello'); };\n");
    plant(root, 'src/app/page.tsx', 'export default function Page() { return null; }\n');

    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_FRONTEND).toBe('true');
    expect(run.lines.SCOPE_TRACKERS).toBe('true');
  });

  it('still reads false when nothing matches, on a large tree', () => {
    const root = scratch('bignomatch');
    plant(root, 'package.json', '{"name":"big","private":true}\n');
    fill(root, BIG, 'export const go = () => 1;\n');

    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_LOGGING).toBe('false');
    // A no-match is not an unhealthy gate.
    expect(run.degraded).toEqual([]);
  });

  it('emits no degraded line on a healthy run', () => {
    const root = scratch('healthy');
    plant(root, 'package.json', '{"name":"healthy","private":true}\n');
    fill(root, 3, "export const go = () => { console.log('hello'); };\n");

    expect(runScope(root).degraded).toEqual([]);
  });
});

describe('an unhealthy gate is loud', () => {
  it('reports SCOPE_DEGRADED beside the false, and still finishes', () => {
    const root = scratch('degraded');
    plant(root, 'package.json', '{"name":"degraded","private":true}\n');
    fill(root, 3, "export const go = () => { console.log('hello'); };\n");

    // A shim that fails only the content-gate form of grep. Everything else on
    // the script's path keeps working, so the run is otherwise normal.
    const bin = scratch('bin');
    const shim = join(bin, 'grep');
    writeFileSync(shim, grepShim('-lIE'));
    chmodSync(shim, 0o755);

    const run = runScope(root, { PATH: `${bin}:${process.env.PATH}` });
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_LOGGING).toBe('false');
    const logging = run.degraded.filter((d) => d.startsWith('SCOPE_LOGGING '));
    expect(logging).toHaveLength(1);
    expect(logging[0]).toMatch(/^SCOPE_LOGGING exit=\d+$/);
    expect(logging[0]).not.toMatch(/exit=(0|1)$/);
  });

  // The case above drives a hits()-based gate. declared() is the only helper
  // whose pipeline continues past the search, so its status was the one that
  // could be masked by a downstream filter -- a real failure reading manifests
  // reported a clean `false`. SCOPE_TRACKERS is its only caller.
  it('reports SCOPE_DEGRADED for a manifest gate too, not just a content gate', () => {
    const root = scratch('degraded-manifest');
    plant(root, 'package.json', '{"name":"d","dependencies":{"posthog-js":"^1.0.0"}}\n');
    fill(root, 3, 'export const go = () => 1;\n');

    // Fail only the recursive manifest search; every other grep still works.
    const bin = scratch('bin-manifest');
    const shim = join(bin, 'grep');
    writeFileSync(shim, grepShim('-rIlE'));
    chmodSync(shim, 0o755);

    const run = runScope(root, { PATH: `${bin}:${process.env.PATH}` });
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_TRACKERS).toBe('false');
    const trackers = run.degraded.filter((d) => d.startsWith('SCOPE_TRACKERS '));
    expect(trackers).toHaveLength(1);
    expect(trackers[0]).not.toMatch(/exit=(0|1)$/);
  });
});

describe('the tracker conjunction ignores commented-out code', () => {
  const base = (root: string) =>
    plant(root, 'package.json', '{"name":"c","private":true,"dependencies":{"react":"^18.0.0"}}\n');

  const cases: Array<[string, string, string]> = [
    ['javascript', 'src/analytics.js', "// gtag('config', 'G-XXXX');\nexport const n = 1;\n"],
    ['python', 'app/views.py', "# gtag('config', 'G-XXXX')\nN = 1\n"],
    ['ruby', 'app/helpers.rb', "# gtag('config', 'G-XXXX')\nN = 1\n"],
    ['html', 'public/index.html', "<!-- <script>gtag('js')</script> -->\n<p>hi</p>\n"],
    ['pug', 'views/layout.pug', "//- gtag('js')\np hi\n"],
    // A `.html` file whose comment is a `//` inside a `<script>` block. This is
    // how a tracker snippet is actually left behind -- the markup rules alone do
    // not touch it, so `html` has to carry the slash rules as well.
    [
      'a script block inside html',
      'public/app.html',
      "<script>\n  // window.dataLayer = window.dataLayer || [];\n  // gtag('config', 'G-XXXX');\n</script>\n<p>hi</p>\n",
    ],
  ];

  for (const [name, file, content] of cases) {
    it(`does not fire on a commented-out tracker in ${name}`, () => {
      const root = scratch(`cmt-${name}`);
      base(root);
      plant(root, file, content);
      const run = runScope(root);
      expect(run.lines.SCOPE_END).toBe('ok');
      expect(run.lines.SIGNAL_TRACKERS_NO_CONSENT).toBe('false');
    });
  }

  it('still fires on live code, and the comment strip is anchored to line start', () => {
    // The live line carries `https://`. An unanchored `//` strip would delete
    // it and silently turn this case into the previous one.
    const root = scratch('live');
    base(root);
    plant(
      root,
      'src/analytics.js',
      "// gtag('config', 'G-XXXX');\nposthog.init(key, { api_host: 'https://eu.i.posthog.com' });\n",
    );
    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SIGNAL_TRACKERS_NO_CONSENT).toBe('true');
  });
});

/**
 * A framework's build directory lists the vendors it *could* wire up. Nuxt writes
 * a composable declaration for every third-party script its module supports, so
 * `.nuxt/imports.d.ts` contains `hotjar` in a project that has never used it.
 *
 * The consent case is the one that matters. `SCOPE_CONSENT` is the negated half of
 * the tracker conjunction, so a false positive there does not raise a finding --
 * it *suppresses* one, which is the direction that goes unnoticed.
 */
describe('generated output is not read as evidence', () => {
  const base = (root: string) =>
    plant(root, 'package.json', '{"name":"g","private":true,"dependencies":{"nuxt":"^3.0.0"}}\n');

  it('does not read a vendor catalogue in .nuxt as session replay', () => {
    const root = scratch('gen-nuxt');
    base(root);
    // Verbatim shape of the real generated line: the lowercase match that trips
    // the gate is in the module path, not the exported name.
    plant(
      root,
      '.nuxt/imports.d.ts',
      "export { useScriptHotjar } from '../node_modules/@nuxt/scripts/dist/runtime/registry/hotjar';\n",
    );
    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_SESSION_REPLAY).toBe('false');
  });

  it('does not let a bundled string in .output stand in for consent machinery', () => {
    const root = scratch('gen-output');
    base(root);
    plant(root, '.output/server/chunks/icons.mjs', 'const icons = { osano: "M0 0h24v24H0z" };\n');
    plant(root, 'src/track.js', "gtag('config', 'G-XXXX');\n");

    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_CONSENT).toBe('false');
    // The point of the case: a stray match in generated output must not be able
    // to switch this off.
    expect(run.lines.SIGNAL_TRACKERS_NO_CONSENT).toBe('true');
  });

  it('still reads the same evidence when it is in real source', () => {
    const root = scratch('gen-control');
    base(root);
    plant(root, 'src/replay.js', "import LogRocket from 'logrocket';\nLogRocket.init('x');\n");
    const run = runScope(root);
    expect(run.lines.SCOPE_SESSION_REPLAY).toBe('true');
  });

  // declared() used to search the whole working directory with only
  // node_modules excluded, so it ignored every other exclusion this file set
  // applies -- including .next, which Next.js fills with a verbatim copy of
  // whatever manifest produced the build. This is not a vendor catalogue like
  // .nuxt/imports.d.ts; it is a real dependency list, just not this project's.
  it('does not read a build directory copy of package.json as a declared dependency', () => {
    const root = scratch('gen-manifest');
    plant(root, 'package.json', '{"name":"app","dependencies":{}}\n');
    plant(
      root,
      '.next/standalone/package.json',
      '{"name":"app","dependencies":{"posthog-js":"^1.0.0","mixpanel-browser":"^2.0.0"}}\n',
    );

    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_TRACKERS).toBe('false');
    expect(run.lines.SIGNAL_TRACKERS_NO_CONSENT).toBe('false');
  });
});

/**
 * A reviewed repository is arbitrary third-party source, and a filename is
 * allowed to look exactly like an option. Both cases below were demonstrated
 * against this script before the `--` terminators were added: the first
 * rewrote the files it was asked to read, the second turned every content
 * gate true on a repository containing none of the things they test for.
 *
 * The first is the one to keep: a review that edits the reviewed tree breaks
 * the only promise the tool makes about itself.
 */
describe('a filename cannot be read as an option', () => {
  const base = (root: string) => plant(root, 'package.json', '{"name":"h","private":true}\n');

  it('does not let a file named -i.js turn sed into an in-place edit', () => {
    const root = scratch('hostile-sed');
    base(root);
    const live = 'const x = 1;\n// a real comment that must survive\n';
    plant(root, 'src/app.js', live);
    plant(root, '-i.js', 'x\n');

    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    // The review is read-only. Byte-identical, and no sed backup beside it.
    expect(readFileSync(join(root, 'src/app.js'), 'utf8')).toBe(live);
    expect(existsSync(join(root, 'src/app.js.js'))).toBe(false);
  });

  it('does not let a file named like a grep pattern flip the content gates', () => {
    const root = scratch('hostile-grep');
    base(root);
    plant(root, 'src/app.js', 'const x = 1;\n');
    plant(root, '--regexp=^|z.js', 'x\n');

    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    for (const gate of [
      'SCOPE_TRACKER_CODE',
      'SCOPE_SESSION_REPLAY',
      'SCOPE_CONSENT',
      'SCOPE_CLIENT_STORAGE',
      'SCOPE_LOGGING',
      'SCOPE_CACHE',
      'SCOPE_OPT_OUT',
      'SCOPE_ERASURE',
    ]) {
      expect({ gate, value: run.lines[gate] }).toEqual({ gate, value: 'false' });
    }
    expect(run.degraded).toEqual([]);
  });
});

// F1 in the private 2026-09-25 live-run triage notes. The gate knew only the
// dedicated replay vendors, so `Sentry.replayIntegration()` recording a tenth of
// all sessions never dispatched the specialist -- while the engine matched
// @sentry/nuxt in the same run. Replay configured inside a general SDK is a
// different shape of evidence and needs its own terms.
describe('session replay inside a general SDK routes the specialist', () => {
  const base = (root: string) => plant(root, 'package.json', '{"name":"r","private":true}\n');

  const cases: Array<[string, string, string]> = [
    [
      'Sentry.replayIntegration()',
      'sentry.client.config.ts',
      "Sentry.init({\n  dsn: 'x',\n  replaysSessionSampleRate: 0.1,\n  integrations: [Sentry.replayIntegration()],\n});\n",
    ],
    [
      'a Sentry replay sample rate alone',
      'sentry.client.config.ts',
      "Sentry.init({ dsn: 'x', replaysOnErrorSampleRate: 1.0 });\n",
    ],
    ['the Sentry replay package', 'src/replay.ts', "import { Replay } from '@sentry/replay';\n"],
    ['Sentry v7 Replay as a class', 'src/sentry.ts', 'integrations: [new Sentry.Replay()],\n'],
    [
      'rrweb used directly',
      'src/rec.ts',
      "import { record } from 'rrweb';\nrecord({ emit() {} });\n",
    ],
    [
      'a Sentry session sample rate alone',
      'src/sentry.ts',
      "Sentry.init({ dsn: 'x', replaysSessionSampleRate: 0.1 });\n",
    ],
    ['Datadog starting a recording', 'src/rum.ts', 'datadogRum.startSessionReplayRecording();\n'],
    [
      'Datadog RUM replay sampling',
      'src/rum.ts',
      "datadogRum.init({ applicationId: 'a', clientToken: 'b', sessionReplaySampleRate: 20 });\n",
    ],
  ];

  for (const [name, file, content] of cases) {
    it(`fires on ${name}`, () => {
      const root = scratch('replay');
      base(root);
      plant(root, file, content);
      const run = runScope(root);
      expect(run.lines.SCOPE_END).toBe('ok');
      expect(run.lines.SCOPE_SESSION_REPLAY).toBe('true');
    });
  }

  it('stays false on a Sentry init with no replay', () => {
    const root = scratch('replay-control');
    base(root);
    plant(root, 'sentry.client.config.ts', "Sentry.init({ dsn: 'x', tracesSampleRate: 0.2 });\n");
    const run = runScope(root);
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_SESSION_REPLAY).toBe('false');
  });
});

// F2 in the private 2026-09-25 live-run triage notes. SCOPE_OPT_OUT was computed,
// not routed, and not listed as context -- an orphan nobody could tell was
// deliberate. Every gate scope.sh emits must now be named in SKILL.md, either in
// the dispatch table or in the context-only list.
describe('every gate is accounted for in SKILL.md', () => {
  const skill = readFileSync('skill/privacy-review/SKILL.md', 'utf8');
  const step2At = skill.indexOf('## Step 2');
  const step3At = skill.indexOf('## Step 3');
  const step2 = skill.slice(step2At, step3At);
  // The dispatch table only: from its header row to the first blank line, so a
  // later table in the same step cannot count as routing.
  const tableAt = step2.indexOf('| Specialist |');
  const table = step2.slice(tableAt, step2.indexOf('\n\n', tableAt));
  const contextAt = step2.indexOf('**Not every gate selects a specialist.**');
  const context = step2.slice(contextAt, step2.indexOf('\n\n', contextAt));

  // What scope.sh actually prints, not what a regex over its source finds: an
  // indented or renamed `gate` call would otherwise escape the check.
  const root = scratch('accounted');
  plant(root, 'package.json', '{"name":"a","private":true}\n');
  const printed = Object.keys(runScope(root).lines).filter(
    (key) => key.startsWith('SCOPE_') && key !== 'SCOPE_PROTO' && key !== 'SCOPE_END',
  );

  it('finds the sections it checks, so it cannot pass vacuously', () => {
    expect({ step2At, step3At, tableAt, contextAt }).toEqual({
      step2At: expect.any(Number),
      step3At: expect.any(Number),
      tableAt: expect.any(Number),
      contextAt: expect.any(Number),
    });
    for (const at of [step2At, step3At, tableAt, contextAt]) expect(at).toBeGreaterThanOrEqual(0);
    expect(step3At).toBeGreaterThan(step2At);
    expect(printed.length).toBeGreaterThan(10);
  });

  for (const gate of printed) {
    it(`${gate} dispatches a specialist or is listed as context`, () => {
      const routed = table.includes(`\`${gate}\``);
      const contextOnly = context.includes(`\`${gate}\``);
      expect({ gate, accountedFor: routed || contextOnly }).toEqual({ gate, accountedFor: true });
      expect({ gate, both: routed && contextOnly }).toEqual({ gate, both: false });
    });
  }
});

describe('the reviewed repository cannot run code through its own git config', () => {
  // scope.sh runs git inside the repository under review. A repository handed
  // over with its .git directory -- an archive, a shared folder -- carries its
  // own .git/config, and git runs a core.fsmonitor command on every index
  // refresh: `git ls-files` in repo mode, the worktree `git diff` calls in diff
  // mode. A clone cannot carry .git/config, which is why no fixture caught it.
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
    });

  const plantedRepo = () => {
    const root = scratch('fsmonitor');
    const marker = join(root, '..', `${root.split('/').pop()}-RAN`);
    git(root, 'init', '-q', '-b', 'main');
    plant(root, 'package.json', '{"name":"planted","private":true}\n');
    plant(root, 'src/app.ts', "export const go = () => fetch('https://api.example.com/x');\n");
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'switch', '-q', '-c', 'feature');
    plant(root, 'src/more.ts', 'export const more = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'feature');
    plant(root, 'src/dirty.ts', 'export const dirty = 2;\n');
    git(root, 'config', 'core.fsmonitor', `touch '${marker}'; false`);
    return { root, marker };
  };

  const run = (cwd: string, args: string[]) =>
    execFileSync('bash', [SCOPE, ...args], { cwd, encoding: 'utf8', env: process.env });

  it.each([
    ['repo mode', ['--repo']],
    ['diff mode', ['--base', 'main']],
  ])('does not run a planted core.fsmonitor in %s', (_mode, args) => {
    const { root, marker } = plantedRepo();
    const out = run(root, args);
    expect(existsSync(marker)).toBe(false);
    // Blocking the hook must not blind the review: the files are still found.
    expect(out).toMatch(/^FILES_UNDER_REVIEW: [1-9]/m);
  });
});

// A git invocation in any spelling a shell accepts: git, "git", 'git', \git.
const BARE_GIT = /(^|[\s;&|($`])\\?["']?git["']?\s/;

describe('every git call in scope.sh goes through git_safe', () => {
  it('has no bare git invocation outside the wrapper', () => {
    const offending = readFileSync(SCOPE, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => BARE_GIT.test(line))
      // The wrapper's own body is the one line allowed to name git.
      .filter((line) => !/ git -c core\.fsmonitor= -c core\.hooksPath=/.test(line));
    expect(offending).toEqual([]);
  });

  it('tells no specialist or the orchestrator to run git itself', () => {
    // SKILL.md used to hand specialists `git ls-files` and `git diff`, which
    // run the reviewed repository's core.fsmonitor and diff drivers.
    const docs = [
      'skill/privacy-review/SKILL.md',
      ...readdirSync('skill/privacy-review/specialists').map(
        (f) => `skill/privacy-review/specialists/${f}`,
      ),
    ];
    for (const doc of docs) {
      const lines = readFileSync(doc, 'utf8')
        .split('\n')
        .filter((line) => /`[^`]*\bgit (ls-files|diff|status|log|show)\b[^`]*`/.test(line));
      expect({ doc, lines }).toEqual({ doc, lines: [] });
    }
  });
});

describe('the reviewed repository cannot run a filter driver through git diff', () => {
  // A clean or process filter assigned by .git/info/attributes runs whenever
  // git hashes a stat-dirty worktree file -- which every file is after an
  // archive is extracted, since extraction re-dates them.
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
    });

  it.each(['clean', 'process'])('does not run a planted %s filter in diff mode', (kind) => {
    const root = scratch(`filter-${kind}`);
    const marker = join(root, '..', `${root.split('/').pop()}-RAN`);
    git(root, 'init', '-q', '-b', 'main');
    plant(root, 'package.json', '{"name":"planted","private":true}\n');
    plant(root, 'src/app.ts', 'export const a = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'switch', '-q', '-c', 'feature');
    plant(root, 'src/app.ts', 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'change');
    plant(root, '.git/info/attributes', '* filter=evil\n');
    git(root, 'config', `filter.evil.${kind}`, `sh -c 'touch "${marker}"; cat'`);
    // Re-date every file, as extracting an archive does.
    execFileSync('touch', [
      '-d',
      '2001-01-01',
      join(root, 'src/app.ts'),
      join(root, 'package.json'),
    ]);

    const out = execFileSync('bash', [SCOPE, '--base', 'main'], { cwd: root, encoding: 'utf8' });
    expect(existsSync(marker)).toBe(false);
    expect(out).toMatch(/^FILES_UNDER_REVIEW: [1-9]/m);
  });
});

describe('a symlink out of the reviewed repository is not reviewed', () => {
  const linked = () => {
    const top = scratch('links');
    const outside = join(top, 'outside');
    const root = join(top, 'repo');
    plant(outside, 'tracker.js', "gtag('config', 'G-OUTSIDE');\n");
    plant(outside, 'dir/tracker.js', "gtag('config', 'G-OUTSIDE');\n");
    plant(root, 'package.json', '{"name":"links","private":true}\n');
    plant(root, 'src/app.js', 'export const app = 1;\n');
    symlinkSync(join(outside, 'tracker.js'), join(root, 'src/linked.js'));
    symlinkSync(join(outside, 'dir'), join(root, 'vendor'));
    // Committed, as a clone delivers them: git ls-files lists a link, where
    // the find fallback does not.
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'links');
    return root;
  };

  it('does not let a linked file or directory raise a gate', () => {
    const { lines } = runScope(linked());
    expect(lines.SCOPE_TRACKER_CODE).toBe('false');
    expect(lines.SIGNAL_TRACKERS_NO_CONSENT).toBe('false');
    expect(lines.FILES_UNDER_REVIEW).toBe('2');
  });

  it('leaves linked paths out of the file list handed to specialists', () => {
    const out = execFileSync('bash', [SCOPE, '--repo', '--list'], {
      cwd: linked(),
      encoding: 'utf8',
    });
    expect(out.split('\n').filter(Boolean).sort()).toEqual(['package.json', 'src/app.js']);
  });
});

describe('git in the reviewed repository reaches no network, no submodule, and fails loudly', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
    });
  const runIn = (cwd: string, args: string[] = []) =>
    execFileSync('bash', [SCOPE, ...args], { cwd, encoding: 'utf8' });

  /** main with one commit; feature adds src/t.js carrying a tracker call. */
  const branched = (tag: string) => {
    const root = scratch(tag);
    git(root, 'init', '-q', '-b', 'main');
    plant(root, 'package.json', '{"name":"b","private":true}\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'switch', '-q', '-c', 'feature');
    plant(root, 'src/t.js', "gtag('config', 'G-X');\n");
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'feature');
    return root;
  };

  /** Deletes the loose tree object for `src` at HEAD, so a diff needs it fetched. */
  const dropSrcTree = (root: string) => {
    const tree = git(root, 'rev-parse', 'HEAD:src').trim();
    rmSync(join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  };

  it('does not lazy-fetch through a promisor remote, and so runs no transport command', () => {
    const root = branched('promisor');
    const marker = join(root, '..', `${root.split('/').pop()}-RAN`);
    git(root, 'config', 'core.repositoryformatversion', '1');
    git(root, 'config', 'extensions.partialClone', 'origin');
    git(root, 'config', 'remote.origin.promisor', 'true');
    git(root, 'config', 'remote.origin.url', 'ssh://evil.invalid/x');
    git(root, 'config', 'core.sshCommand', `sh -c 'touch "${marker}"; exit 1' --`);
    git(root, 'config', 'protocol.ext.allow', 'always');
    dropSrcTree(root);
    const out = runIn(root);
    expect(existsSync(marker)).toBe(false);
    expect(out).toMatch(/^DEGRADED: /m);
  });

  it('reports a failed diff as degraded and still reviews the files, rather than an empty clean set', () => {
    const root = branched('broken');
    dropSrcTree(root);
    const out = runIn(root);
    expect(out).toMatch(/^DEGRADED: /m);
    expect(out).toMatch(/^FILES_UNDER_REVIEW: [1-9]/m);
    expect(out).toMatch(/^SCOPE_TRACKER_CODE: true$/m);
  });

  it('does not run a filter driver defined in a submodule', () => {
    const lib = scratch('sublib');
    git(lib, 'init', '-q', '-b', 'main');
    plant(lib, 'f.txt', 'x\n');
    git(lib, 'add', '.');
    git(lib, 'commit', '-q', '-m', 'lib');
    const root = branched('superproject');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    git(root, 'commit', '-q', '-m', 'submodule');
    const marker = join(root, '..', `${root.split('/').pop()}-RAN`);
    git(join(root, 'lib'), 'config', 'filter.evil.clean', `sh -c 'touch "${marker}"; cat'`);
    plant(root, '.git/modules/lib/info/attributes', '* filter=evil\n');
    execFileSync('touch', ['-d', '2001-01-01', join(root, 'lib', 'f.txt')]);
    runIn(root);
    expect(existsSync(marker)).toBe(false);
  });

  it('does not let a link whose name holds a newline hide another path', () => {
    const root = scratch('newline');
    plant(root, 'package.json', '{"name":"n","private":true}\n');
    plant(root, 'src/t.js', "gtag('config', 'G-X');\n");
    symlinkSync('package.json', join(root, 'zz\nsrc'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'n');
    const out = runIn(root, ['--repo']);
    expect(out).toMatch(/^SCOPE_TRACKER_CODE: true$/m);
    const list = runIn(root, ['--repo', '--list']).split('\n').filter(Boolean);
    expect(list).toContain('src/t.js');
  });
});

describe('git is believed only about this directory, and only for paths inside it', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
    });
  const runIn = (cwd: string, args: string[] = []) =>
    execFileSync('bash', [SCOPE, ...args], { cwd, encoding: 'utf8', timeout: 20000 });

  it('does not review a path outside the repository that a crafted tree lists', () => {
    const top = scratch('dotdot');
    const root = join(top, 'repo');
    plant(top, 'outside/secret.js', "gtag('config', 'G-OUTSIDE');\n");
    plant(root, 'package.json', '{"name":"d","private":true}\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, 'switch', '-q', '-c', 'feature');
    // A tree with an entry named `..`, which git mktree accepts and git diff
    // then reports as ../outside/secret.js.
    const blob = git(root, 'hash-object', '-w', join(top, 'outside/secret.js')).trim();
    const mk = (input: string) =>
      execFileSync('git', ['mktree'], { cwd: root, input, encoding: 'utf8' }).trim();
    const outsideTree = mk(`100644 blob ${blob}\tsecret.js\n`);
    const dotdotTree = mk(`040000 tree ${outsideTree}\toutside\n`);
    const pkg = git(root, 'rev-parse', 'HEAD:package.json').trim();
    const rootTree = mk(`040000 tree ${dotdotTree}\t..\n100644 blob ${pkg}\tpackage.json\n`);
    const commit = execFileSync(
      'git',
      [
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit-tree',
        rootTree,
        '-p',
        'HEAD',
        '-m',
        'x',
      ],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    git(root, 'reset', '-q', '--soft', commit);

    const out = runIn(root);
    expect(out).toMatch(/^SIGNAL_TRACKERS_NO_CONSENT: false$/m);
    expect(out).toMatch(/^DEGRADED: .*outside/m);
    const list = runIn(root, ['--list']);
    expect(list).not.toContain('outside');
  });

  it('does not take a parent repository as the reviewed one', () => {
    const parent = scratch('ancestor');
    git(parent, 'init', '-q', '-b', 'main');
    plant(parent, 'README.md', 'parent\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-q', '-m', 'p');
    const drop = join(parent, 'vendor-drop');
    plant(drop, 'package.json', '{"name":"drop","private":true}\n');
    plant(drop, 'src/a.js', "gtag('config', 'G-X');\n");
    const out = runIn(drop, ['--repo']);
    expect(out).toMatch(/^SCOPE_TRACKER_CODE: true$/m);
    expect(out).toMatch(/^FILES_UNDER_REVIEW: [1-9]/m);
  });

  it('does not follow a .git file to another repository', () => {
    const top = scratch('gitfile');
    const other = join(top, 'other');
    mkdirSync(other, { recursive: true });
    git(other, 'init', '-q', '-b', 'main');
    const root = join(top, 'repo');
    plant(root, 'src/a.js', "gtag('config', 'G-X');\n");
    plant(root, '.git', `gitdir: ${join(other, '.git')}\n`);
    const out = runIn(root, ['--repo']);
    expect(out).toMatch(/^DEGRADED: /m);
    expect(out).toMatch(/^SCOPE_TRACKER_CODE: true$/m);
  });

  it('reports an empty index over a populated tree instead of an empty review', () => {
    const root = scratch('emptyindex');
    plant(root, 'package.json', '{"name":"e","private":true}\n');
    plant(root, 'src/a.js', "gtag('config', 'G-X');\n");
    git(root, 'init', '-q', '-b', 'main');
    const out = runIn(root, ['--repo']);
    expect(out).toMatch(/^DEGRADED: /m);
    expect(out).toMatch(/^SCOPE_TRACKER_CODE: true$/m);
  });

  it('does not hang on a FIFO inside .git', () => {
    const root = scratch('gitfifo');
    plant(root, 'src/a.js', "gtag('config', 'G-X');\n");
    git(root, 'init', '-q', '-b', 'main');
    rmSync(join(root, '.git', 'config'));
    execFileSync('mkfifo', [join(root, '.git', 'config')]);
    const out = runIn(root, ['--repo']);
    expect(out).toMatch(/^DEGRADED: /m);
    expect(out).toMatch(/^SCOPE_TRACKER_CODE: true$/m);
  });
});

describe('SKILL.md carries every DEGRADED line into the report', () => {
  it('names DEGRADED as a coverage gap the report must state', () => {
    const skill = readFileSync('skill/privacy-review/SKILL.md', 'utf8');
    expect(skill).toMatch(/`DEGRADED:`[\s\S]{0,400}NOT CHECKED/);
  });
});

describe('plain bugs from the fourth hardening review', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
    });
  const runIn = (cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) =>
    execFileSync('bash', [SCOPE, ...args], { cwd, encoding: 'utf8', timeout: 45000, env });

  it('does not hang on a package.json that is a FIFO', () => {
    const root = scratch('pkgfifo');
    plant(root, 'src/a.js', 'export const a = 1;\n');
    execFileSync('mkfifo', [join(root, 'package.json')]);
    expect(runIn(root, ['--repo'])).toMatch(/^SCOPE_END: ok$/m);
  });

  it('does not read a package.json linked from outside the repository', () => {
    const top = scratch('pkglink');
    plant(top, 'outside/package.json', '{"dependencies":{"next":"14.0.0"}}\n');
    const root = join(top, 'repo');
    plant(root, 'src/a.js', 'export const a = 1;\n');
    symlinkSync(join(top, 'outside/package.json'), join(root, 'package.json'));
    expect(runIn(root, ['--repo'])).not.toMatch(/^STACK: .*\bnext\b/m);
  });

  it('stops asking git after the first timeout, and says it timed out', () => {
    const root = scratch('reffifo');
    plant(root, 'src/a.js', "gtag('config', 'G-X');\n");
    git(root, 'init', '-q', '-b', 'main');
    for (const ref of ['main', 'master', 'develop']) {
      execFileSync('mkfifo', [join(root, '.git', 'refs', 'heads', ref)]);
    }
    const started = Date.now();
    const out = runIn(root);
    expect(Date.now() - started).toBeLessThan(40000);
    expect(out).toMatch(/^DEGRADED: .*timed out/m);
    expect(out).toMatch(/^SCOPE_TRACKER_CODE: true$/m);
  }, 60000);

  it("ignores a GIT_INDEX_FILE in the reviewer's environment", () => {
    const other = scratch('otherindex');
    plant(other, 'elsewhere.js', 'export const e = 1;\n');
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'add', '.');
    const root = scratch('ownindex');
    plant(root, 'src/a.js', 'export const a = 1;\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    const list = runIn(root, ['--repo', '--list'], {
      ...process.env,
      GIT_INDEX_FILE: join(other, '.git', 'index'),
    });
    expect(list).toContain('src/a.js');
    expect(list).not.toContain('elsewhere.js');
  });

  it('says a subdirectory of a repository is one, rather than "not a Git repository"', () => {
    const root = scratch('subdir');
    plant(root, 'pkg/src/a.js', 'export const a = 1;\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'x');
    expect(runIn(join(root, 'pkg'))).toMatch(/^DEGRADED: .*subdirectory/m);
  });

  it('reviews source under a nested directory named .git that git cannot track', () => {
    const root = scratch('nestedgit');
    plant(root, 'package.json', '{"name":"n","private":true}\n');
    plant(root, 'lib/.git/t.js', "gtag('config', 'G-X');\n");
    expect(runIn(root, ['--repo'])).toMatch(/^SCOPE_TRACKER_CODE: true$/m);
  });

  it('does not believe git when objects/info/alternates points elsewhere', () => {
    const root = scratch('alternates');
    plant(root, 'src/a.js', 'export const a = 1;\n');
    git(root, 'init', '-q', '-b', 'main');
    plant(root, '.git/objects/info/alternates', '/elsewhere/objects\n');
    expect(runIn(root, ['--repo'])).toMatch(/^DEGRADED: .*alternates/m);
  });
});

describe('portability and the last borrowed-repository forms', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
    });
  const runIn = (cwd: string, args: string[] = []) =>
    execFileSync('bash', [SCOPE, ...args], { cwd, encoding: 'utf8', timeout: 45000 });

  it('writes every case pattern in the (pattern) form bash 3.2 parses inside $(...)', () => {
    // macOS ships bash 3.2, which cannot parse `pattern)` inside a command
    // substitution: scope.sh died before printing a gate, and --list printed
    // nothing at all. CI has no bash 3.2, so the form is pinned here.
    const offending = readFileSync(SCOPE, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .flatMap((line) => {
        const m = /\bcase\b.*\bin\b(.*)$/.exec(line);
        return m?.[1] && /[^(\s][^;]*\)/.test(m[1]) && !/^\s*\(/.test(m[1]) ? [line] : [];
      });
    expect(offending).toEqual([]);
  });

  it('does not believe git when .git/commondir names another repository', () => {
    const other = scratch('commondir-other');
    git(other, 'init', '-q', '-b', 'main');
    const root = scratch('commondir');
    plant(root, 'src/a.js', 'export const a = 1;\n');
    git(root, 'init', '-q', '-b', 'main');
    plant(root, '.git/commondir', `${join(other, '.git')}\n`);
    expect(runIn(root, ['--repo'])).toMatch(/^DEGRADED: .*commondir/m);
  });

  it('does not believe git when .git/objects is a link', () => {
    const other = scratch('objects-other');
    git(other, 'init', '-q', '-b', 'main');
    const root = scratch('objectslink');
    plant(root, 'src/a.js', 'export const a = 1;\n');
    git(root, 'init', '-q', '-b', 'main');
    rmSync(join(root, '.git', 'objects'), { recursive: true });
    symlinkSync(join(other, '.git', 'objects'), join(root, '.git', 'objects'));
    expect(runIn(root, ['--repo'])).toMatch(/^DEGRADED: .*objects/m);
  });

  it('tells the orchestrator a run without SCOPE_END is a stop, not an empty review', () => {
    const skill = readFileSync('skill/privacy-review/SKILL.md', 'utf8');
    expect(skill).toMatch(/`SCOPE_END: ok`[\s\S]{0,300}(stop|not run)/i);
  });
});

// A real bash 3.2 run, where the image is available locally; CI has no 3.2.
const hasBash32 = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', 'bash:3.2'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBash32)('scope.sh under bash 3.2', () => {
  it('prints the whole gate block and a non-empty --list', () => {
    const root = scratch('bash32');
    plant(root, 'package.json', '{"name":"b","private":true}\n');
    plant(root, 'src/a.js', "gtag('config', 'G-X');\n");
    const script = readFileSync(SCOPE, 'utf8');
    const run = (args: string) =>
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          '-v',
          `${root}:/repo`,
          '-w',
          '/repo',
          'bash:3.2',
          'bash',
          '-s',
          '--',
          ...args.split(' ').filter(Boolean),
        ],
        { input: script, encoding: 'utf8', timeout: 60000 },
      );
    expect(run('--repo')).toMatch(/^SCOPE_END: ok$/m);
    expect(run('--repo --list')).toContain('src/a.js');
  }, 120000);
});

describe('a tracker reached without its SDK still routes', () => {
  it('reads SCOPE_TRACKER_CODE on a beacon to a collection host', () => {
    const root = scratch('beacon');
    plant(root, 'package.json', '{"name":"x"}');
    plant(
      root,
      'src/analytics.ts',
      "navigator.sendBeacon('https://www.google-analytics.com/g/collect', e);\n",
    );
    expect(runScope(root).lines.SCOPE_TRACKER_CODE).toBe('true');
  });

  it('reads it on a plain fetch to a collection host, and not on a first-party fetch', () => {
    const root = scratch('beacon-host');
    plant(root, 'package.json', '{"name":"x"}');
    plant(root, 'src/a.ts', "fetch('https://eu.i.posthog.com/capture/', { method: 'POST' });\n");
    expect(runScope(root).lines.SCOPE_TRACKER_CODE).toBe('true');
    const clean = scratch('first-party');
    plant(clean, 'package.json', '{"name":"x"}');
    plant(clean, 'src/a.ts', "fetch('/api/events', { method: 'POST' });\n");
    expect(runScope(clean).lines.SCOPE_TRACKER_CODE).toBe('false');
  });

  it('routes without asserting: the tracker conjunction is unchanged', () => {
    const root = scratch('beacon-signal');
    plant(root, 'package.json', '{"name":"x"}');
    plant(
      root,
      'src/a.ts',
      "navigator.sendBeacon('https://www.google-analytics.com/g/collect');\n",
    );
    expect(runScope(root).lines.SIGNAL_TRACKERS_NO_CONSENT).toBe('false');
  });
});

describe('an argument scope.sh does not know is refused', () => {
  it.each([['some/dir'], ['--repo', 'some/dir'], ['--lst']])(
    'exits 2 with no SCOPE_END for %s',
    (...args) => {
      const root = scratch('args');
      plant(root, 'package.json', '{"name":"x"}');
      let code = 0;
      let stdout = '';
      let stderr = '';
      try {
        stdout = execFileSync('bash', [SCOPE, ...args], {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (error) {
        const e = error as { status: number; stdout: string; stderr: string };
        code = e.status;
        stdout = e.stdout;
        stderr = e.stderr;
      }
      expect(code).toBe(2);
      expect(stdout).not.toContain('SCOPE_END');
      expect(stderr).toContain('unknown argument');
    },
  );
});
