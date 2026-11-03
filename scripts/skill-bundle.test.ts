import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The bundled CLI inside plugin/skills/privacy-review/ is a build artifact committed to
 * the repository, which means it can silently fall behind the source it was
 * built from. A stale privacy tool is worse than an absent one: it reports on
 * an old knowledge base while looking current.
 *
 * These assertions fail loudly and name the command that fixes them, rather
 * than letting a drifted bundle ship quietly.
 */

const BIN = 'plugin/skills/privacy-review/bin';
const FIX = 'run `pnpm build && pnpm skill:bundle`';

const bundle = () =>
  JSON.parse(readFileSync(`${BIN}/BUNDLE.json`, 'utf8')) as {
    toolVersion: string;
    kbVersion: string;
    bundledAt: string;
  };

describe('the bundled CLI shipped with the skill', () => {
  it('exists at the path the resolver looks for', () => {
    // scan-transfers.sh execs exactly this path; a rename breaks the specialist
    // silently, because the script would just fall through to the next source.
    expect(existsSync(`${BIN}/lib/egressa.mjs`), `missing bundle: ${FIX}`).toBe(true);
    expect(existsSync(`${BIN}/BUNDLE.json`), `missing manifest: ${FIX}`).toBe(true);
  });

  it('is a real bundle rather than a stub', () => {
    // Guards against a truncated or partial copy. The real artifact is ~500 KB;
    // anything under 50 KB is not a bundled CLI.
    expect(statSync(`${BIN}/lib/egressa.mjs`).size).toBeGreaterThan(50_000);
  });

  it('carries its own shebang and require shim, so it runs as a program', () => {
    const head = readFileSync(`${BIN}/lib/egressa.mjs`, 'utf8').slice(0, 200);
    expect(head.startsWith('#!/usr/bin/env node')).toBe(true);
    // Without this the inlined CommonJS throws "Dynamic require ... not supported"
    // on first use, which only shows up outside a node_modules tree.
    expect(head).toContain('createRequire');
  });

  it('was built from the current tool version', () => {
    const source = readFileSync('packages/cli/src/version.ts', 'utf8');
    const current = source.match(/TOOL_VERSION\s*=\s*'([^']+)'/)?.[1];
    expect(current).toBeTruthy();
    expect(bundle().toolVersion, `bundle is stale: ${FIX}`).toBe(current);
  });

  it('carries the current knowledge base', () => {
    // The KB is the half that actually goes out of date -- vendor jurisdictions
    // and adequacy status change while the code does not.
    const current = readFileSync('kb/kb.version', 'utf8').trim();
    expect(bundle().kbVersion, `bundled kb is stale: ${FIX}`).toBe(current);
    expect(readFileSync(`${BIN}/kb/kb.version`, 'utf8').trim()).toBe(current);
  });
});
