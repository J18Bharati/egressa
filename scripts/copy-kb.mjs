/**
 * Copies the knowledge base and the licence files into each publishable package.
 *
 * The data is CC-BY-4.0 while the code is MIT, so both live at the repo
 * root as the single source of truth and are copied in rather than duplicated in
 * git. Each tarball must carry what governs it:
 *
 *   - LICENSE (MIT requires it with every copy) and NOTICE (the code/data split) in every package;
 *   - THIRD_PARTY_NOTICES in every package whose bundle inlines third-party code;
 *   - kb/ with its own kb/LICENSE (CC-BY-4.0) in every package that ships data.
 *
 * Two entry points, one script:
 *
 *   node scripts/copy-kb.mjs           every package -- the tail of `pnpm build`
 *   node scripts/copy-kb.mjs <dir>     one package   -- each package's `prepack`
 *
 * `prepack` runs it so that `pnpm pack` and `pnpm publish` are correct from a
 * clean checkout, without depending on `pnpm build` having been run last. It
 * names a single package because `pnpm -r pack` runs the packages concurrently,
 * and one package's prepack deleting another's kb/ mid-pack would be a race.
 *
 * The one-package form also refuses to continue without a built dist/, so an
 * unbuilt checkout cannot be published as an empty package.
 *
 * Paths resolve from this file, not from the working directory: prepack runs
 * with the package as cwd, the build runs with the repository root.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages, whether they ship the knowledge base, and whether their bundle inlines dependencies. */
const packages = {
  core: { kb: false, inlines: false },
  'kb-loader': { kb: true, inlines: false },
  cli: { kb: true, inlines: true },
  mcp: { kb: true, inlines: true },
};

const only = process.argv[2];
if (only !== undefined && !Object.hasOwn(packages, only)) {
  console.error(
    `copy-kb: unknown package "${only}" (expected one of ${Object.keys(packages).join(', ')})`,
  );
  process.exit(1);
}

for (const [dir, { kb, inlines }] of Object.entries(packages)) {
  if (only !== undefined && only !== dir) continue;
  const pkg = join(root, 'packages', dir);

  if (only !== undefined && !existsSync(join(pkg, 'dist'))) {
    console.error(`copy-kb: packages/${dir}/dist is missing -- run \`pnpm build\` before packing`);
    process.exit(1);
  }

  const files = ['LICENSE', 'NOTICE', ...(inlines ? ['THIRD_PARTY_NOTICES'] : [])];
  const missing = files.filter((file) => !existsSync(join(root, file)));
  if (missing.length > 0) {
    // A package that inlines MIT code and ships without its notices is out of licence.
    console.error(`copy-kb: ${missing.join(', ')} missing at the root -- run \`pnpm build\``);
    process.exit(1);
  }
  for (const file of files) {
    cpSync(join(root, file), join(pkg, file));
  }
  console.log(`copied ${files.join(', ')} -> packages/${dir}`);

  if (kb) {
    const target = join(pkg, 'kb');
    rmSync(target, { recursive: true, force: true });
    cpSync(join(root, 'kb'), target, { recursive: true });
    console.log(`copied kb -> packages/${dir}/kb`);
  }
}
