#!/usr/bin/env node
/**
 * Carry the version Changesets just wrote into every other place that states it.
 *
 *   changeset version && node scripts/sync-version.mjs
 *
 * `VERSION` is the source of truth that `scripts/version-consistency.test.ts` pins
 * everything to, and two source literals (`TOOL_VERSION`) must match it. Changesets
 * only edits `package.json`, so without this step the version pull request fails
 * `pnpm test` on the very first run. The committed skill bundle also carries the
 * version, which the release script regenerates after this (`pnpm skill:bundle`).
 *
 * The four packages are a `fixed` group, so they must already agree. Disagreement
 * is an error rather than a pick-the-highest, because a split version is exactly
 * the broken install the group exists to prevent.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFESTS = [
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/kb-loader/package.json',
  'packages/mcp/package.json',
];

const LITERALS = [
  ['packages/cli/src/version.ts', /(TOOL_VERSION\s*=\s*')[^']+(')/],
  ['packages/mcp/src/server.ts', /(const TOOL_VERSION\s*=\s*')[^']+(')/],
];

const versions = MANIFESTS.map((file) => [file, JSON.parse(readFileSync(file, 'utf8')).version]);
const distinct = new Set(versions.map(([, v]) => v));
if (distinct.size !== 1 || !/^\d+\.\d+\.\d+$/.test([...distinct][0])) {
  console.error('sync-version: the four packages do not share one plain semver version:');
  for (const [file, v] of versions) console.error(`  ${file}: ${v}`);
  process.exit(1);
}
const version = [...distinct][0];

writeFileSync('VERSION', `${version}\n`);

for (const [file, pattern] of LITERALS) {
  const before = readFileSync(file, 'utf8');
  if (!pattern.test(before)) {
    console.error(`sync-version: no TOOL_VERSION literal found in ${file}`);
    process.exit(1);
  }
  writeFileSync(file, before.replace(pattern, `$1${version}$2`));
}

// Claude Code decides whether an installed plugin needs updating from this
// field, so a stale value hides every release from plugin installs.
const PLUGIN = '.claude-plugin/plugin.json';
const plugin = JSON.parse(readFileSync(PLUGIN, 'utf8'));
plugin.version = version;
writeFileSync(PLUGIN, `${JSON.stringify(plugin, null, 2)}\n`);

console.log(`sync-version: ${version}`);
