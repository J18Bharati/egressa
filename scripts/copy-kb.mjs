/**
 * Copies the knowledge base into each publishable package.
 *
 * The data is CC-BY-4.0 while the code is Apache-2.0, so it lives at the repo
 * root as the single source of truth and is copied in at build time rather than
 * duplicated in git. Each package ships kb/LICENSE alongside it.
 */
import { cpSync, rmSync } from 'node:fs';

const targets = ['packages/kb-loader/kb', 'packages/cli/kb', 'packages/mcp/kb'];
for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  cpSync('kb', target, { recursive: true });
  console.log(`copied kb -> ${target}`);
}
