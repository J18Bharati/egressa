/**
 * Boots both binaries from the tarballs npm would publish, installed in a clean
 * container.
 *
 *   pnpm smoke:pack
 *
 * `scripts/smoke-dist.mjs` proves the repository's own `dist/` starts. This
 * proves the *published shape* starts: `pnpm pack` rewrites `workspace:*`, drops
 * everything outside `files`, and installs with no workspace, no hoisting and no
 * stray `node_modules` in a parent directory to lean on. The bundle's shape has
 * changed twice, and each change was a way for the two to differ.
 *
 * Manual only. It needs Docker, and network for the registry install of the
 * third-party dependencies, so it is not part of `build`, `verify` or CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const IMAGE = 'node:20-slim';
const PACKAGES = ['core', 'kb-loader', 'cli', 'mcp'];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

run('pnpm', ['build']);

const out = mkdtempSync(join(tmpdir(), 'egressa-pack-'));
try {
  for (const pkg of PACKAGES) {
    run('pnpm', ['pack', '--pack-destination', out], { cwd: resolve('packages', pkg) });
  }
  const tarballs = readdirSync(out).filter((f) => f.endsWith('.tgz'));
  process.stdout.write(`smoke-pack: packed ${tarballs.join(', ')}\n`);

  // All four are installed together: the CLI and MCP manifests declare
  // @egressa/core and @egressa/kb as runtime dependencies even though tsup
  // bundles them, so an `egressa` tarball alone would try to fetch a
  // @egressa/core that has never been published.
  const inContainer = [
    'set -e',
    'mkdir /work && cd /work',
    'npm init -y >/dev/null',
    `npm install --no-audit --no-fund ${tarballs.map((t) => `/tarballs/${t}`).join(' ')}`,
    'node /smoke/smoke-dist.mjs node_modules/egressa/dist/cli.js node_modules/@egressa/mcp/dist/server.js',
  ].join('\n');

  run('docker', [
    'run',
    '--rm',
    '-v',
    `${out}:/tarballs:ro`,
    '-v',
    `${resolve('scripts/smoke-dist.mjs')}:/smoke/smoke-dist.mjs:ro`,
    IMAGE,
    'sh',
    '-c',
    inContainer,
  ]);
  process.stdout.write('smoke-pack: ok\n');
} finally {
  rmSync(out, { recursive: true, force: true });
}
