#!/usr/bin/env node
/**
 * Copy the built CLI and the knowledge base into skill/privacy-review/bin/ so the
 * transfers specialist can run a scan with no install step.
 *
 * Layout matters. kb-loader's bundledKbPath() looks for `../kb` relative to the
 * JavaScript file, so the binary sits in bin/lib/ and the data in bin/kb/.
 * The directory is `lib`, not `dist`, because the repo's .gitignore excludes
 * `dist/` everywhere -- naming it dist would silently drop the bundle from git
 * and ship a skill whose transfers specialist cannot run.
 *
 * Run: pnpm skill:bundle   (after pnpm build)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC_CLI = join(ROOT, 'packages/cli/dist/cli.js');
const SRC_KB = join(ROOT, 'kb');
const OUT = join(ROOT, 'skill/privacy-review/bin');

if (!existsSync(SRC_CLI)) {
  console.error('bundle-skill-cli: packages/cli/dist/cli.js is missing. Run `pnpm build` first.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'lib'), { recursive: true });

// The .map is deliberately not copied: it is twice the size of the bundle and
// nothing consumes it here.
cpSync(SRC_CLI, join(OUT, 'lib', 'egressa.mjs'));
cpSync(SRC_KB, join(OUT, 'kb'), { recursive: true });

const toolVersion = readFileSync(join(ROOT, 'packages/cli/src/version.ts'), 'utf8').match(
  /TOOL_VERSION\s*=\s*'([^']+)'/,
)?.[1];
const kbVersion = readFileSync(join(SRC_KB, 'kb.version'), 'utf8').trim();
if (!toolVersion) {
  console.error('bundle-skill-cli: could not read TOOL_VERSION from packages/cli/src/version.ts');
  process.exit(1);
}

writeFileSync(
  join(OUT, 'BUNDLE.json'),
  `${JSON.stringify({ toolVersion, kbVersion, bundledAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
);

console.log(`bundled egressa ${toolVersion} + kb ${kbVersion} -> skill/privacy-review/bin/`);
