/**
 * `pnpm kb:tasks [--as-of YYYY-MM-DD]`: the verification tasks the shipped
 * knowledge base generates, as JSON on stdout. Scans nothing and reaches no
 * network. A maintainer, or an agent working for one, takes a task, opens only
 * the pages in its `where`, edits `kb/vendors/<id>.json` and runs
 * `pnpm kb:validate`. The flow is in kb/KB_POLICY.md under "Re-verifying".
 */
import { join } from 'node:path';
import { knowledgeBaseTasks, loadKnowledgeBase } from '../src/index.js';

const args = process.argv.slice(2);
const at = args.indexOf('--as-of');
const asOfArg = at >= 0 ? args[at + 1] : undefined;
const asOf = asOfArg ? new Date(`${asOfArg}T00:00:00Z`) : new Date();
// Round-tripped, because Date rolls 2026-02-30 over to March rather than refusing it.
if (
  at >= 0 &&
  (asOfArg === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg) ||
    Number.isNaN(asOf.getTime()) ||
    asOf.toISOString().slice(0, 10) !== asOfArg)
) {
  process.stderr.write('kb:tasks: --as-of takes a calendar date, YYYY-MM-DD\n');
  process.exit(2);
}

const kb = loadKnowledgeBase({ kbPath: join(process.cwd(), 'kb') });
const tasks = knowledgeBaseTasks(kb, asOf);
process.stdout.write(
  `${JSON.stringify({ kbVersion: kb.version, asOf: asOf.toISOString().slice(0, 10), tasks }, null, 2)}\n`,
);
