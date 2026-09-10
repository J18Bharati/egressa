/**
 * Knowledge base coverage: the fraction of detected hosts and packages that
 * match a knowledge base entry.
 *
 * Without telemetry this is the only recall signal the project has. A scan's
 * `unmatched` block is the denominator's other half, and it is part of the
 * published findings contract for exactly this reason.
 *
 * This is a report, not a gate. It exits 0 whatever the number, because a low
 * figure is a fact about the size of the knowledge base rather than a fault in
 * the code -- and a coverage threshold in CI is the kind of check that gets
 * satisfied by adding thin entries.
 *
 *   pnpm kb:coverage                 # every fixture repository
 *   pnpm kb:coverage path/to/repo    # a repository of your own
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ScanResult, scan } from '@egressa/core';

const FIXTURES = 'fixtures/repos';
const KB_PATH = 'kb';
const TOOL_VERSION = '0.0.0-coverage';

interface Tally {
  matchedHosts: Set<string>;
  unmatchedHosts: Set<string>;
  matchedPackages: Set<string>;
  unmatchedPackages: Set<string>;
  unresolved: number;
}

function emptyTally(): Tally {
  return {
    matchedHosts: new Set(),
    unmatchedHosts: new Set(),
    matchedPackages: new Set(),
    unmatchedPackages: new Set(),
    unresolved: 0,
  };
}

function tally(result: ScanResult, into: Tally): void {
  for (const finding of result.findings) {
    for (const signal of finding.signals) {
      if (signal.unresolvedReason) {
        into.unresolved += 1;
        continue;
      }
      if (signal.vendorId === null) continue;
      const bucket = signal.kind === 'dependency' ? into.matchedPackages : into.matchedHosts;
      bucket.add(signal.matchedOn);
    }
  }
  for (const host of result.unmatched.hosts) into.unmatchedHosts.add(host);
  for (const pkg of result.unmatched.packages) into.unmatchedPackages.add(pkg);
}

function percent(matched: number, total: number): string {
  if (total === 0) return '    n/a';
  return `${((matched / total) * 100).toFixed(1).padStart(6)}%`;
}

function line(label: string, matched: number, unmatched: number): string {
  const total = matched + unmatched;
  return `  ${label.padEnd(10)} ${percent(matched, total)}  (${matched}/${total} matched)`;
}

function targets(): string[] {
  const given = process.argv.slice(2);
  if (given.length > 0) return given.map((p) => resolve(p));
  return readdirSync(FIXTURES)
    .map((name) => join(FIXTURES, name))
    .filter((path) => statSync(path).isDirectory())
    .sort();
}

const overall = emptyTally();
const rows: string[] = [];

for (const root of targets()) {
  // Read kb/ at the repo root, not the copy under packages/*/kb that
  // `pnpm build` produces. The copy is stale between a KB edit and the next
  // build, which would report a fresh entry as a coverage miss.
  const result = scan({ root, toolVersion: TOOL_VERSION, kbPath: KB_PATH, includeCallsites: true });
  const one = emptyTally();
  tally(result, one);
  tally(result, overall);

  const hosts = one.matchedHosts.size + one.unmatchedHosts.size;
  const packages = one.matchedPackages.size + one.unmatchedPackages.size;
  rows.push(
    `  ${root.padEnd(38)} hosts ${percent(one.matchedHosts.size, hosts)}` +
      `   packages ${percent(one.matchedPackages.size, packages)}`,
  );
}

process.stdout.write(`Knowledge base coverage over ${targets().length} repository/ies\n\n`);
process.stdout.write(`${rows.join('\n')}\n\n`);
process.stdout.write('Combined, deduplicated:\n');
process.stdout.write(`${line('hosts', overall.matchedHosts.size, overall.unmatchedHosts.size)}\n`);
process.stdout.write(
  `${line('packages', overall.matchedPackages.size, overall.unmatchedPackages.size)}\n`,
);

if (overall.unmatchedHosts.size > 0) {
  process.stdout.write(
    `\nUnmatched hosts:\n  ${[...overall.unmatchedHosts].sort().join('\n  ')}\n`,
  );
}
if (overall.unmatchedPackages.size > 0) {
  process.stdout.write(
    `\nUnmatched packages:\n  ${[...overall.unmatchedPackages].sort().join('\n  ')}\n`,
  );
  process.stdout.write(
    '\nEvery declared dependency counts towards the package denominator, including\n' +
      'frameworks and build tools that are not third-party data recipients at all.\n' +
      'The package figure is therefore a floor, not an accuracy measure; the list\n' +
      'above is the part worth reading.\n',
  );
}
if (overall.unresolved > 0) {
  process.stdout.write(
    `\n${overall.unresolved} call site(s) had no resolvable host, so they count towards neither figure.\n`,
  );
}
