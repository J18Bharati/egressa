/**
 * Knowledge base validator. Runs as `pnpm kb:validate` and as a separate CI job
 * on kb/** changes, so a data error never looks like an engine regression and a
 * first-time contributor adding one vendor gets targeted feedback quickly.
 *
 * Network checks live in a separate nightly job on purpose: a flaky link check
 * in someone's first pull request is how you lose contributors.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { aliasCounts, collisionIssues, entryIssues, unobservedDpfRecords } from '../src/checks.js';
import type { VendorEntry } from '../src/types.js';

const KB = join(process.cwd(), 'kb');
const STALE_AFTER_DAYS = 180;

/** EEA members, so a region in an EEA country satisfies an `EEA` jurisdiction. */
const EEA_MEMBERS = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
]);

const errors: string[] = [];
const warnings: string[] = [];

const ajv = new Ajv2020({ allErrors: true, strict: false });
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const compile = (name: string) => ajv.compile(load(join(KB, 'schema', name)));

const validateVendor = compile('vendor-1.0.0.json');
const validateAdequacy = compile('adequacy-status-1.0.0.json');

const today = new Date().toISOString().slice(0, 10);
const daysSince = (iso: string) => Math.floor((Date.parse(today) - Date.parse(iso)) / 86_400_000);

/**
 * The furthest ahead of UTC a `lastVerified` date may sit before it is wrong.
 *
 * `lastVerified` is a plain calendar date with no timezone, written by whoever
 * verified the entry, in their local calendar. `today` is UTC. An author in any
 * zone ahead of UTC -- which is most of them -- writes tomorrow's UTC date for
 * part of every day, and rejecting that is a clock artifact rather than a
 * finding about the data. One day of tolerance covers every real offset;
 * anything further ahead is a typo or a fabricated date.
 */
const FUTURE_TOLERANCE_DAYS = 1;

// --- vendor entries -------------------------------------------------------
const vendorDir = join(KB, 'vendors');
const vendorFiles = readdirSync(vendorDir).filter((f) => f.endsWith('.json'));
const entries: VendorEntry[] = [];

for (const file of vendorFiles) {
  const path = join(vendorDir, file);
  const entry = load(path);
  const where = `kb/vendors/${file}`;

  // 1. schema
  if (!validateVendor(entry)) {
    for (const e of validateVendor.errors ?? []) {
      errors.push(`${where}: ${e.instancePath || '/'} ${e.message}`);
    }
    continue;
  }

  // 2. filename matches id
  if (basename(file, '.json') !== entry.id) {
    errors.push(`${where}: filename does not match id "${entry.id}"`);
  }
  entries.push(entry);

  // 3. lastVerified sanity and staleness
  if (daysSince(entry.lastVerified) < -FUTURE_TOLERANCE_DAYS) {
    errors.push(`${where}: lastVerified ${entry.lastVerified} is in the future`);
  } else if (daysSince(entry.lastVerified) > STALE_AFTER_DAYS) {
    warnings.push(
      `${where}: lastVerified ${entry.lastVerified} is ${daysSince(entry.lastVerified)} days old (reported as kb/stale-entry at scan time)`,
    );
  }

  // 4. region map sanity
  //
  // Deliberately no prefix check. `eu-west-2` is London and `eu-central-2` is
  // Zurich, and a warning that those "look wrong" would be silenced by the next
  // contributor writing IE -- which is the exact error the map exists to stop.
  const regionCodes = new Set<string>();
  const undescribed = new Set<string>();
  const jurisdictionCountries = new Set(
    (entry.processing.jurisdictions ?? []).map((j: { country: string }) => j.country),
  );
  for (const region of (entry.regions ?? []) as { code: string; country: string }[]) {
    if (regionCodes.has(region.code)) {
      errors.push(`${where}: region "${region.code}" is listed more than once`);
    }
    regionCodes.add(region.code);
    // A region resolving to a country the entry never mentions is worth
    // saying out loud, but it is a warning rather than an error: a cloud
    // provider publishes dozens of regions, and forcing every one of them into
    // processing.jurisdictions would turn that field into a country list and
    // bury the few jurisdictions that carry legal weight -- the contracting
    // entity, and wherever support can reach the data from.
    const coveredByEea = EEA_MEMBERS.has(region.country) && jurisdictionCountries.has('EEA');
    if (!jurisdictionCountries.has(region.country) && !coveredByEea) {
      undescribed.add(region.country);
    }
  }
  // One line per entry, not one per region.
  if (undescribed.size > 0) {
    warnings.push(
      `${where}: regions resolve to ${[...undescribed].sort().join(', ')}, which processing.jurisdictions does not mention`,
    );
  }
}

// 5. per-entry and set-wide checks, shared with anything else that judges an
// entry against the shipped set (packages/kb-loader/src/checks.ts).
const fileFor = (vendorId: string) => `kb/vendors/${vendorId}.json`;
for (const issue of [...entries.flatMap(entryIssues), ...collisionIssues(entries)]) {
  errors.push(`${fileFor(issue.vendorId)}: ${issue.message}`);
}
for (const entry of entries) {
  for (const url of unobservedDpfRecords(entry)) {
    warnings.push(
      `${fileFor(entry.id)}: DPF record ${url} claims certification with no observedStatus (a verification task)`,
    );
  }
}

// --- adequacy status ------------------------------------------------------
const adequacy = load(join(KB, 'adequacy-status.json'));
if (!validateAdequacy(adequacy)) {
  for (const e of validateAdequacy.errors ?? []) {
    errors.push(`kb/adequacy-status.json: ${e.instancePath || '/'} ${e.message}`);
  }
}

// --- report ---------------------------------------------------------------
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length > 0) {
  console.error(`\nKnowledge base validation FAILED (${errors.length} error(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
const counts = aliasCounts(entries);
console.log(
  `Knowledge base OK: ${vendorFiles.length} vendor(s), ${counts.packages} package alias(es) ` +
    `including ${counts.scopes} scope(s), ` +
    `${counts.hosts} host pattern(s), ${adequacy.decisions.length} adequacy decision(s), ` +
    `${warnings.length} warning(s).`,
);
