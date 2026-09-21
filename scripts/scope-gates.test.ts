import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

const scratch = (tag: string) => mkdtempSync(join(tmpdir(), `egressa-scope-${tag}-`));

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
    writeFileSync(
      shim,
      '#!/bin/sh\nfor a in "$@"; do case "$a" in -lIE) exit 2 ;; esac; done\nexec /usr/bin/grep "$@"\n',
    );
    chmodSync(shim, 0o755);

    const run = runScope(root, { PATH: `${bin}:${process.env.PATH}` });
    expect(run.lines.SCOPE_END).toBe('ok');
    expect(run.lines.SCOPE_LOGGING).toBe('false');
    const logging = run.degraded.filter((d) => d.startsWith('SCOPE_LOGGING '));
    expect(logging).toHaveLength(1);
    expect(logging[0]).toMatch(/^SCOPE_LOGGING exit=\d+$/);
    expect(logging[0]).not.toMatch(/exit=(0|1)$/);
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
});
