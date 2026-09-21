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
const validateOverrides = compile('exposure-overrides-1.0.0.json');

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
const vendorIds = new Set<string>();
const packageOwners = new Map<string, string>(); // "npm:name" -> vendorId
const scopeOwners = new Map<string, string>(); // "npm:@scope/" -> vendorId
const hostOwners = new Map<string, string>(); // "pattern|match" -> vendorId

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

  // 8. filename matches id
  if (basename(file, '.json') !== entry.id) {
    errors.push(`${where}: filename does not match id "${entry.id}"`);
  }
  if (vendorIds.has(entry.id)) errors.push(`${where}: duplicate vendor id "${entry.id}"`);
  vendorIds.add(entry.id);

  // 2. at least one primary source
  const primary = entry.sources.filter(
    (s: { publisher: string }) => s.publisher === 'vendor' || s.publisher === 'regulator',
  );
  if (primary.length === 0) {
    errors.push(`${where}: needs at least one source published by the vendor or a regulator`);
  }

  // 3. lastVerified sanity and staleness
  if (daysSince(entry.lastVerified) < -FUTURE_TOLERANCE_DAYS) {
    errors.push(`${where}: lastVerified ${entry.lastVerified} is in the future`);
  } else if (daysSince(entry.lastVerified) > STALE_AFTER_DAYS) {
    warnings.push(
      `${where}: lastVerified ${entry.lastVerified} is ${daysSince(entry.lastVerified)} days old (reported as kb/stale-entry at scan time)`,
    );
  }

  // 4. cross-vendor alias collisions -- silent misattribution bugs if allowed
  for (const [ecosystem, list] of Object.entries(entry.aliases.packages ?? {})) {
    for (const alias of list as { name: string }[]) {
      const key = `${ecosystem}:${alias.name}`;
      const owner = packageOwners.get(key);
      if (owner && owner !== entry.id) {
        errors.push(`${where}: package alias "${key}" already claimed by "${owner}"`);
      }
      packageOwners.set(key, entry.id);
      // A wildcard alias claims a whole registry namespace. Recorded here and
      // cross-checked once every entry is read, because an overlap is a
      // property of the set and the file that introduces it may be read first.
      if (alias.name.endsWith('/*')) {
        scopeOwners.set(`${ecosystem}:${alias.name.slice(0, -1)}`, entry.id);
      }
    }
  }
  for (const host of entry.aliases.hosts as { pattern: string; match: string }[]) {
    const key = `${host.pattern}|${host.match}`;
    const owner = hostOwners.get(key);
    if (owner && owner !== entry.id) {
      errors.push(`${where}: host pattern "${host.pattern}" already claimed by "${owner}"`);
    }
    hostOwners.set(key, entry.id);

    // 5. host pattern sanity: never a bare public suffix
    const labels = host.pattern.split('.');
    if (labels.length < 2) {
      errors.push(`${where}: host pattern "${host.pattern}" has too few labels`);
    }
    if (host.match === 'suffix' && labels.length < 2) {
      errors.push(`${where}: suffix pattern "${host.pattern}" is too broad`);
    }
  }

  // 7. region map sanity
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
  // One line per entry, not one per region. A cloud provider publishes dozens
  // of regions and a warning repeated twenty-four times is a warning nobody
  // reads.
  if (undescribed.size > 0) {
    warnings.push(
      `${where}: regions resolve to ${[...undescribed].sort().join(', ')}, which processing.jurisdictions does not mention`,
    );
  }

  // 6. no evaluative language in the data layer
  //
  // Collected from every prose-bearing path rather than a hardcoded two. The
  // old list named `notes` and `euRegion.notes` only, so `sdkDefaults[].effect`
  // -- several paragraphs in some entries -- was never scanned. A vocabulary
  // guard that covers some of the prose is a guard someone will route around
  // without meaning to.
  const prose = [
    entry.notes ?? '',
    entry.processing.euRegion?.notes ?? '',
    ...(entry.processing.jurisdictions ?? []).map((j: { note?: string }) => j.note ?? ''),
    ...(entry.sdkDefaults ?? []).map((d: { effect?: string }) => d.effect ?? ''),
    ...(entry.regions ?? []).map(
      (r: { label?: string; note?: string }) => `${r.label ?? ''} ${r.note ?? ''}`,
    ),
  ].join(' ');
  for (const word of ['risky', 'dangerous', 'avoid', 'bad ', 'unsafe', 'problematic']) {
    if (prose.toLowerCase().includes(word)) {
      errors.push(`${where}: evaluative language "${word.trim()}" belongs in the ratings layer`);
    }
  }
}

// --- 4b. wildcard scope overlap across vendors -----------------------------
//
// `lookupPackage` refuses to attribute a name two vendors' scopes both match,
// so an overlap costs recall silently rather than producing a wrong vendor.
// Catching it in the data is better: the contributor who writes the swallowing
// scope is the one who can say which vendor owns the namespace, and by the
// time a scan is running nobody is looking.
//
// An npm scope is a registry-enforced namespace, which is the whole
// justification for prefix matching here -- `@sentry/*` is Sentry by
// construction, where `eu-*` is not the EEA by construction. Two vendors
// claiming one namespace means that justification has stopped holding for at
// least one of them, so it is an error rather than a warning.
const fileFor = (vendorId: string) => `kb/vendors/${vendorId}.json`;
for (const [scope, owner] of scopeOwners) {
  for (const [other, otherOwner] of scopeOwners) {
    if (other === scope || otherOwner === owner) continue;
    if (other.startsWith(scope)) {
      errors.push(
        `${fileFor(owner)}: package scope "${scope}*" swallows scope "${other}*" claimed by "${otherOwner}"`,
      );
    }
  }
  for (const [pkg, pkgOwner] of packageOwners) {
    if (pkgOwner === owner || pkg.endsWith('/*')) continue;
    if (pkg.startsWith(scope)) {
      errors.push(
        `${fileFor(owner)}: package scope "${scope}*" swallows package alias "${pkg}" claimed by "${pkgOwner}"`,
      );
    }
  }
}

// --- adequacy status ------------------------------------------------------
const adequacy = load(join(KB, 'adequacy-status.json'));
if (!validateAdequacy(adequacy)) {
  for (const e of validateAdequacy.errors ?? []) {
    errors.push(`kb/adequacy-status.json: ${e.instancePath || '/'} ${e.message}`);
  }
}

// --- overrides ------------------------------------------------------------
const overrides = load(join(KB, 'ratings/exposure-overrides.json'));
if (!validateOverrides(overrides)) {
  for (const e of validateOverrides.errors ?? []) {
    errors.push(`kb/ratings/exposure-overrides.json: ${e.instancePath || '/'} ${e.message}`);
  }
} else {
  // 7. overrides must reference a real vendor
  for (const o of overrides.overrides as { vendorId: string }[]) {
    if (!vendorIds.has(o.vendorId)) {
      errors.push(`kb/ratings/exposure-overrides.json: unknown vendor id "${o.vendorId}"`);
    }
  }
}

// --- report ---------------------------------------------------------------
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length > 0) {
  console.error(`\nKnowledge base validation FAILED (${errors.length} error(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `Knowledge base OK: ${vendorFiles.length} vendor(s), ${packageOwners.size} package alias(es) ` +
    `including ${scopeOwners.size} scope(s), ` +
    `${hostOwners.size} host pattern(s), ${adequacy.decisions.length} adequacy decision(s), ` +
    `${warnings.length} warning(s).`,
);
