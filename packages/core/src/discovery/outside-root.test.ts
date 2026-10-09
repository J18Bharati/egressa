import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePnpmLock } from '../manifests/pnpm-lock.js';
import { scan } from '../scan.js';
import { readInsideRoot } from './read-inside.js';

/**
 * The scanned repository is untrusted input, and a symlink is part of it.
 *
 * The walk used to follow symlinks and every reader opened what it was given,
 * so a repository could commit `pnpm-lock.yaml -> ~/.aws/credentials` and
 * have the file read. The YAML parser's error message quotes the line it
 * failed on, and that message reached JSON, SARIF and the MCP result. Nothing
 * whose real path leaves the scan root is read now, by any reader.
 */

const base = { toolVersion: '0.1.0', kbPath: 'kb', now: new Date('2026-10-09T00:00:00Z') };
const SENTINEL = 'OUTSIDE-SENTINEL';

// Creating a symlink needs a privilege Windows does not grant by default.
const symlinks = process.platform !== 'win32';

const setup = () => {
  const top = mkdtempSync(join(tmpdir(), 'egressa-outside-'));
  const outside = join(top, 'outside');
  const repo = join(top, 'repo');
  mkdirSync(outside);
  mkdirSync(join(repo, 'src'), { recursive: true });

  // Not YAML: the parser fails on the first line and its message quotes it.
  writeFileSync(join(outside, 'credentials'), `[${SENTINEL}\naws_secret_access_key = x\n`);
  // The sentinel shares the call's line, so a finding's snippet would carry it.
  writeFileSync(
    join(outside, 'client.ts'),
    `export const go = () => fetch('https://api.stripe.com/v1/charges'); // ${SENTINEL}\n`,
  );
  writeFileSync(join(outside, 'ignore'), `${SENTINEL}\n`);

  writeFileSync(join(repo, 'package.json'), '{"name":"repo","private":true}\n');
  writeFileSync(join(repo, 'src', 'real.ts'), 'export const real = 1;\n');
  symlinkSync(join(outside, 'credentials'), join(repo, 'pnpm-lock.yaml'));
  symlinkSync(join(outside, 'client.ts'), join(repo, 'src', 'linked.ts'));
  symlinkSync(outside, join(repo, 'deps'));
  symlinkSync(join(outside, 'ignore'), join(repo, '.gitignore'));
  // A link that stays inside the repository is still the repository's own file.
  symlinkSync(join(repo, 'src', 'real.ts'), join(repo, 'src', 'alias.ts'));
  return repo;
};

describe.skipIf(!symlinks)('a symlink out of the scan root is not read', () => {
  const repo = setup();
  const result = scan({ ...base, root: repo, includeCallsites: true });
  const text = JSON.stringify(result);

  it('carries no content from any file outside the root, on any surface', () => {
    expect(text).not.toContain(SENTINEL);
  });

  it('reports no finding sourced from a file outside the root', () => {
    expect(text).not.toContain('api.stripe.com');
  });

  it('does not list a linked file or descend into a linked directory', () => {
    // Recorded in docs/LIMITATIONS.md: links are not followed at all, in
    // either direction. Only the real package.json is a manifest here.
    expect(result.scan.manifestsScanned).toBe(1);
    expect(result.errors.find((e) => e.file === 'pnpm-lock.yaml')).toBeUndefined();
  });
});

describe.skipIf(!symlinks)('readInsideRoot', () => {
  const repo = setup();

  it('refuses a link whose real path leaves the root, without reading it', () => {
    expect(() => readInsideRoot(repo, 'pnpm-lock.yaml')).toThrow(/outside the scan root/);
    expect(() => readInsideRoot(repo, '.gitignore')).toThrow(/outside the scan root/);
    expect(() => readInsideRoot(repo, 'deps/client.ts')).toThrow(/outside the scan root/);
  });

  it('reads a link that stays inside the root, and a plain file', () => {
    expect(readInsideRoot(repo, 'src/alias.ts')).toContain('real = 1');
    expect(readInsideRoot(repo, 'src/real.ts')).toContain('real = 1');
  });

  it('does not mistake a name beginning with two dots for a parent', () => {
    writeFileSync(join(repo, '..notparent.ts'), 'export const n = 1;\n');
    expect(readInsideRoot(repo, '..notparent.ts')).toContain('n = 1');
  });
});

describe('a lockfile parse error does not quote the lockfile', () => {
  it('keeps only the first line of the YAML message', () => {
    const { errors } = parsePnpmLock(`[${SENTINEL}\nsecond: line\n`, 'pnpm-lock.yaml');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).not.toContain(SENTINEL);
    expect(errors[0]?.message).not.toContain('\n');
  });
});

describe.skipIf(!symlinks)('a file that is not a regular file is not read', () => {
  it('does not hang on a FIFO committed as an ignore file', () => {
    const top = mkdtempSync(join(tmpdir(), 'egressa-fifo-'));
    writeFileSync(join(top, 'package.json'), '{"name":"fifo","private":true}\n');
    execFileSync('mkfifo', [join(top, '.gitignore')]);
    execFileSync('mkfifo', [join(top, '.egressaignore')]);
    // A blocking open would wait for a writer forever; the test timeout is the assertion.
    const result = scan({ ...base, root: top });
    expect(result.scan.manifestsScanned).toBe(1);
  }, 5000);

  it('refuses a FIFO through readInsideRoot rather than blocking', () => {
    const top = mkdtempSync(join(tmpdir(), 'egressa-fifo-'));
    execFileSync('mkfifo', [join(top, 'pipe.ts')]);
    expect(() => readInsideRoot(top, 'pipe.ts')).toThrow(/not a regular file/);
  }, 5000);
});

describe.skipIf(!symlinks || process.getuid?.() === 0)(
  'a read error does not disclose a local path',
  () => {
    it('reports the error code, not a message carrying the absolute root', () => {
      const top = mkdtempSync(join(tmpdir(), 'egressa-eacces-'));
      writeFileSync(join(top, 'package.json'), '{"name":"eacces","private":true}\n');
      mkdirSync(join(top, 'src'));
      writeFileSync(join(top, 'src', 'app.ts'), "fetch('https://api.stripe.com/v1');\n");
      chmodSync(join(top, 'src', 'app.ts'), 0o000);
      const result = scan({ ...base, root: top, includeCallsites: true });
      chmodSync(join(top, 'src', 'app.ts'), 0o644);
      const error = result.errors.find((e) => e.file === 'src/app.ts');
      expect(error?.message).toMatch(/EACCES/);
      expect(error?.message).not.toContain(top);
    });
  },
);
