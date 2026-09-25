/**
 * Boots both built binaries and fails the build if either cannot start.
 *
 *   node scripts/smoke-dist.mjs [cliBin] [mcpBin]
 *
 * Defaults to the repository's own `dist/` output. `scripts/smoke-pack.mjs`
 * passes the paths of an installed tarball instead.
 *
 * It exists because the MCP server shipped unable to start, and 385 passing
 * tests never saw it: vitest aliases every package to its source, so nothing in
 * the suite loads a bundle. This runs *after* the build, as the last step of
 * `pnpm build`, and never before tests -- CLAUDE.md forbids a build step there.
 *
 * Starting is not enough. Each binary also scans a two-file repository, and the
 * result must come from the native parser (`engine.degraded` false, a call-site
 * finding present) and from the knowledge base shipped *beside that binary*.
 * `--version` and a tool listing load neither, so a tarball missing `kb/`, or
 * one that silently fell back to manifest-only analysis, would pass without it.
 *
 * The MCP client library is resolved from the package beside the MCP binary,
 * never through a bare import. From `scripts/` a bare import finds whatever copy
 * of the SDK happens to sit in a parent directory (a stray one in `~` passed
 * locally), and on a fresh clone finds none.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 20_000;

const cliBin = resolve(process.argv[2] ?? 'packages/cli/dist/cli.js');
const mcpBin = resolve(process.argv[3] ?? 'packages/mcp/dist/server.js');

/** Each binary lives in `<package>/dist/`, so its manifest is one level up. */
const manifestBeside = (bin) => resolve(dirname(bin), '..', 'package.json');

function fail(what, detail) {
  process.stderr.write(`smoke-dist: ${what}\n${detail ? `${detail.trimEnd()}\n` : ''}`);
  process.exit(1);
}

// --- CLI -------------------------------------------------------------------

const expected = JSON.parse(readFileSync(manifestBeside(cliBin), 'utf8')).version;
const cli = spawnSync(process.execPath, [cliBin, '--version'], {
  encoding: 'utf8',
  timeout: TIMEOUT_MS,
});
if (cli.error) fail(`${cliBin} did not run: ${cli.error.message}`, cli.stderr);
if (cli.status !== 0) fail(`${cliBin} --version exited ${cli.status}`, cli.stderr || cli.stdout);
if (cli.stdout.trim() !== expected) {
  fail(`${cliBin} --version printed ${JSON.stringify(cli.stdout.trim())}, expected ${expected}`);
}

// --- A scan through the CLI ------------------------------------------------

/** The knowledge base version shipped in `<package>/kb/`, beside the binary. */
function shippedKbVersion(bin) {
  const file = resolve(dirname(bin), '..', 'kb', 'kb.version');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    fail(`${bin} ships no knowledge base: ${file} is missing`);
  }
}

/** A fixture both analyses must see: a manifest entry and a resolvable call. */
const repo = mkdtempSync(join(tmpdir(), 'egressa-smoke-'));
writeFileSync(
  join(repo, 'package.json'),
  '{"name":"smoke","private":true,"dependencies":{"stripe":"^14.0.0"}}\n',
);
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'src', 'pay.ts'), "await fetch('https://api.stripe.com/v1/charges');\n");
process.on('exit', () => rmSync(repo, { recursive: true, force: true }));

/** The same three facts, whichever binary produced the document. */
function checkScan(bin, doc, expectedKb) {
  if (doc?.scan?.engine?.degraded !== false) {
    fail(`${bin} scanned in degraded mode: ${JSON.stringify(doc?.scan?.engine)}`);
  }
  if (doc.kb?.version !== expectedKb) {
    fail(`${bin} loaded knowledge base ${doc.kb?.version}, but ships ${expectedKb}`);
  }
  const kinds = new Set((doc.findings ?? []).flatMap((f) => f.evidence.map((e) => e.kind)));
  if (!kinds.has('dependency') || !kinds.has('callsite')) {
    fail(
      `${bin} scan found evidence of kinds [${[...kinds].join(', ')}]`,
      JSON.stringify(doc.summary),
    );
  }
}

const scanned = spawnSync(process.execPath, [cliBin, 'scan', repo, '--format', 'json'], {
  encoding: 'utf8',
  timeout: TIMEOUT_MS,
});
if (scanned.status !== 0) fail(`${cliBin} scan exited ${scanned.status}`, scanned.stderr);
checkScan(cliBin, JSON.parse(scanned.stdout), shippedKbVersion(cliBin));

// --- MCP server ------------------------------------------------------------

const sdk = createRequire(manifestBeside(mcpBin));
const load = (subpath) =>
  import(pathToFileURL(sdk.resolve(`@modelcontextprotocol/sdk/${subpath}`)).href);
const { Client } = await load('client/index.js');
const { StdioClientTransport } = await load('client/stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpBin],
  stderr: 'pipe',
});
let serverStderr = '';
transport.stderr?.on('data', (chunk) => {
  serverStderr += chunk;
});

const client = new Client({ name: 'egressa-smoke', version: '0' }, { capabilities: {} });
const timer = setTimeout(() => {
  transport.close().catch(() => {});
  fail(`${mcpBin} did not answer within ${TIMEOUT_MS / 1000}s`, serverStderr);
}, TIMEOUT_MS);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  if (!names.includes('scan_repository')) {
    fail(`${mcpBin} listed no scan_repository tool (got: ${names.join(', ')})`, serverStderr);
  }
  const result = await client.callTool({
    name: 'scan_repository',
    arguments: { path: repo, full: true },
  });
  checkScan(mcpBin, JSON.parse(result.content[0].text), shippedKbVersion(mcpBin));
} catch (error) {
  fail(`${mcpBin} failed to start: ${error.message}`, serverStderr);
} finally {
  clearTimeout(timer);
  await client.close().catch(() => {});
}

process.stdout.write(
  `smoke-dist: ok -- ${cliBin} ${expected} and ${mcpBin} both scan with the native parser and their own knowledge base\n`,
);
