import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The repository a skill reviews is untrusted input. A review must never execute
 * anything it supplies.
 *
 * Both scan scripts used to walk up from the scan target and `exec node` the
 * first `packages/cli/dist/cli.js` they found, so a repository that committed one
 * had it run with the reviewer's credentials. And both skills ran their scripts
 * by paths relative to the working directory, which is usually the repository
 * under review, so a committed `skill/privacy-review/scripts/...` was the copy
 * that ran.
 *
 * The first half plants a marker-writing `cli.js` in the target and in its
 * parent, and asserts neither marker appears. The second half pins the skill
 * text, because an instruction a model follows cannot be executed here.
 */

const SCRIPTS = [
  { skill: 'privacy-review', file: 'scan-transfers.sh' },
  { skill: 'egressa', file: 'scan.sh' },
];

/** A `cli.js` that records that it ran by writing `marker`. */
const plantedCli = (dir: string, marker: string) => {
  const path = join(dir, 'packages', 'cli', 'dist', 'cli.js');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nconsole.log('PLANTED');\n`,
  );
};

interface Sandbox {
  root: string;
  script: string;
  target: string;
  run: () => string;
}

/**
 * An installed copy of one scan script, with nothing beside it to resolve, an
 * `egressa` stub first on PATH, and a target nested one level inside a parent
 * directory.
 */
const sandbox = (skill: string, file: string): Sandbox => {
  const root = mkdtempSync(join(tmpdir(), 'egressa-untrusted-'));
  const script = join(root, 'install', 'skill', skill, 'scripts', file);
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(resolve('skill', skill, 'scripts', file), script);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const stub = join(bin, 'egressa');
  writeFileSync(stub, '#!/bin/sh\necho "STUB $*"\n');
  chmodSync(stub, 0o755);

  const target = join(root, 'parent', 'target');
  mkdirSync(target, { recursive: true });

  const run = () =>
    execFileSync('bash', [script, target], {
      cwd: target,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    });
  return { root, script, target, run };
};

describe.each(SCRIPTS)('$file never runs a build the scan target supplies', ({ skill, file }) => {
  it('ignores a cli.js in the target and in its parent', () => {
    const box = sandbox(skill, file);
    const inTarget = join(box.root, 'ran-from-target');
    const inParent = join(box.root, 'ran-from-parent');
    plantedCli(box.target, inTarget);
    plantedCli(dirname(box.target), inParent);

    const out = box.run();

    expect(existsSync(inTarget)).toBe(false);
    expect(existsSync(inParent)).toBe(false);
    expect(out).not.toContain('PLANTED');
    // It fell through to PATH, so resolution still worked rather than giving up.
    expect(out).toContain('STUB scan');
  });

  it('still prefers the build in the checkout the script lives in', () => {
    // Removing the walk-up must not cost Egressa reviewing itself the native parser.
    const box = sandbox(skill, file);
    const marker = join(box.root, 'ran-from-checkout');
    plantedCli(join(box.root, 'install'), marker);

    box.run();

    expect(existsSync(marker)).toBe(true);
  });
});

/** Every markdown file shipped under `skill/`, computed so a new one is covered. */
const skillMarkdown = (): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'bin') walk(path);
      } else if (entry.name.endsWith('.md')) {
        found.push(path);
      }
    }
  };
  walk('skill');
  return found.sort();
};

describe('skill text resolves nothing from the working directory', () => {
  const files = skillMarkdown();

  it('finds the skill markdown', () => {
    expect(files).toContain(join('skill', 'privacy-review', 'SKILL.md'));
    expect(files).toContain(join('skill', 'egressa', 'SKILL.md'));
  });

  it.each(files)('%s runs every script from $SKILL_DIR', (file) => {
    const offending = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /\bbash\b.*\bscripts\/[\w-]+\.sh\b/.test(line))
      .filter((line) => !/"\$SKILL_DIR\/scripts\/[\w-]+\.sh"/.test(line));
    expect(offending).toEqual([]);
  });

  it('reads specialist checklists from $SKILL_DIR and has no working-directory candidates', () => {
    const skill = readFileSync('skill/privacy-review/SKILL.md', 'utf8');
    expect(skill).toContain('`$SKILL_DIR/specialists/`');
    expect(skill).not.toMatch(/"\.claude\/skills\/privacy-review"|"skill\/privacy-review"/);
    // The specialists are told which copy to run.
    expect(skill).toMatch(/absolute `SKILL_DIR`/);
  });
});
