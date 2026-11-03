/**
 * Knowledge base checks beyond the JSON Schema, shared by `pnpm kb:validate`
 * and by anything that judges a single entry against the shipped set -- a
 * locally drafted vendor entry, or a contribution built from one.
 *
 * Messages never quote free text from an entry. They name a field, an alias or
 * an id, which are the things a contributor needs to find the problem; quoting
 * a note would carry whatever a hostile file put there into the output.
 */
import { DPF_STATUS_QUALIFIED, dpfStatusVerdict } from './dpf-status.js';
import { normalisePypiName } from './pypi.js';
import type { VendorEntry } from './types.js';

/** One problem, attributed to the vendor whose data introduces it. */
export interface EntryIssue {
  vendorId: string;
  message: string;
  /**
   * The message with every value taken from an entry replaced, unless it is a
   * plain name. What a check on a repository-supplied entry may print: that
   * entry's text is untrusted, and the quoting in `message` is decoration, not
   * a boundary, since a value can contain the quote character.
   */
  redacted: string;
}

const PLAIN_VALUE = /^[a-z0-9@/*:._-]{1,80}$/;

/** A message from a template, and the same message with its values redacted. */
function issue(
  strings: TemplateStringsArray,
  ...values: unknown[]
): { message: string; redacted: string } {
  const join = (show: (v: string) => string) =>
    strings.reduce(
      (out, text, i) => out + text + (i < values.length ? show(String(values[i])) : ''),
      '',
    );
  return {
    message: join((v) => v),
    redacted: join((v) => (PLAIN_VALUE.test(v) ? v : '(not shown)')),
  };
}

/** Words that make a data-layer sentence evaluative. Facts only belong in kb/. */
const EVALUATIVE = ['risky', 'dangerous', 'avoid', 'bad ', 'unsafe', 'problematic'];

/** Checks one entry needs no other entry to answer. */
export function entryIssues(entry: VendorEntry): EntryIssue[] {
  const issues: EntryIssue[] = [];
  const add = (text: { message: string; redacted: string }) =>
    issues.push({ vendorId: entry.id, ...text });

  const primary = entry.sources.filter(
    (s) => s.publisher === 'vendor' || s.publisher === 'regulator',
  );
  if (primary.length === 0) {
    add(issue`needs at least one source published by the vendor or a regulator`);
  }

  for (const [ecosystem, list] of Object.entries(entry.aliases.packages ?? {})) {
    for (const alias of list ?? []) {
      const key = `${ecosystem}:${alias.name}`;
      // `kind` decides the confidence an alias emits, and nothing else checked
      // that it agrees with the name. `{"name": "@sentry/*", "kind":
      // "official-sdk"}` is the dangerous direction: it validates, and then a
      // build-time plugin matched only by its namespace is reported at high
      // confidence, which is exactly what `scope` exists to prevent.
      if (alias.name.endsWith('/*') !== (alias.kind === 'scope')) {
        add(
          issue`package alias "${key}" has kind "${alias.kind}" -- a name ending "/*" must be kind "scope", and only such a name may be`,
        );
      }
      // PyPI treats `Twilio`, `twilio` and `twi_lio`-style spellings as one
      // project and the manifest readers emit the PEP 503 form, so an alias in
      // any other spelling can never match -- a silent recall gap. PyPI has no
      // namespaces either, so a wildcard there claims nothing real.
      if (ecosystem === 'pypi') {
        const normalised = normalisePypiName(alias.name);
        if (alias.name !== normalised || alias.name.endsWith('/*')) {
          add(
            issue`pypi alias "${alias.name}" must be written in PEP 503 normalised form ("${normalised}"), with no wildcard`,
          );
        }
      }
    }
  }

  // A DPF record's `dpfCertified` must be what the closed status table says
  // its observed status means, so the shipped data and a repository-supplied
  // fact can never read the same status two ways.
  for (const m of entry.legal.transferMechanisms) {
    if (m.mechanism !== 'DPF' || m.observedStatus === undefined) continue;
    const verdict = dpfStatusVerdict(m.observedStatus, m.acceptQualifiedStatus !== undefined);
    if (verdict.certified !== (m.dpfCertified === true)) {
      add(
        issue`DPF record ${m.url ?? '(no url)'}: dpfCertified is ${m.dpfCertified === true}, but its observed status reads as ${verdict.kind}, which means ${verdict.certified}`,
      );
    }
    if (m.acceptQualifiedStatus && verdict.kind !== 'qualified') {
      add(
        issue`DPF record ${m.url ?? '(no url)'}: acceptQualifiedStatus applies only to "${DPF_STATUS_QUALIFIED}"`,
      );
    }
  }

  for (const host of entry.aliases.hosts) {
    // Never a bare public suffix.
    if (host.pattern.split('.').length < 2) {
      add(issue`host pattern "${host.pattern}" has too few labels`);
    }
  }

  // Collected from every prose-bearing path rather than a hardcoded two. The
  // old list named `notes` and `euRegion.notes` only, so `sdkDefaults[].effect`
  // -- several paragraphs in some entries -- was never scanned.
  const prose = [
    entry.notes ?? '',
    entry.processing.euRegion?.notes ?? '',
    ...(entry.processing.jurisdictions ?? []).map((j) => j.note ?? ''),
    ...(entry.sdkDefaults ?? []).map((d) => d.effect ?? ''),
    ...(entry.regions ?? []).map((r) => `${r.label ?? ''} ${r.note ?? ''}`),
  ]
    .join(' ')
    .toLowerCase();
  for (const word of EVALUATIVE) {
    if (prose.includes(word)) {
      add(issue`evaluative language "${word.trim()}" does not belong in the data layer`);
    }
  }
  return issues;
}

/**
 * Checks that are properties of the set: two vendors claiming one alias, one
 * namespace swallowing another vendor's, a name that reads as two vendors.
 *
 * Each is a silent misattribution or a silent recall gap at scan time, so it is
 * caught in the data, where the contributor who wrote the conflict can say
 * which vendor owns the name.
 */
export function collisionIssues(entries: readonly VendorEntry[]): EntryIssue[] {
  const issues: EntryIssue[] = [];
  const vendorIds = new Set<string>();
  const packageOwners = new Map<string, string>(); // "npm:name" -> vendorId
  const scopeOwners = new Map<string, string>(); // "npm:@scope/" -> vendorId
  const hostOwners = new Map<string, string>(); // "pattern|match" -> vendorId

  for (const entry of entries) {
    const add = (text: { message: string; redacted: string }) =>
      issues.push({ vendorId: entry.id, ...text });
    if (vendorIds.has(entry.id)) add(issue`duplicate vendor id "${entry.id}"`);
    vendorIds.add(entry.id);
    for (const [ecosystem, list] of Object.entries(entry.aliases.packages ?? {})) {
      for (const alias of list ?? []) {
        const key = `${ecosystem}:${alias.name}`;
        const owner = packageOwners.get(key);
        if (owner && owner !== entry.id) {
          add(issue`package alias "${key}" already claimed by "${owner}"`);
        }
        packageOwners.set(key, entry.id);
        if (alias.name.endsWith('/*')) {
          scopeOwners.set(`${ecosystem}:${alias.name.slice(0, -1)}`, entry.id);
        }
      }
    }
    for (const host of entry.aliases.hosts) {
      const key = `${host.pattern}|${host.match}`;
      const owner = hostOwners.get(key);
      if (owner && owner !== entry.id) {
        add(issue`host pattern "${host.pattern}" already claimed by "${owner}"`);
      }
      hostOwners.set(key, entry.id);
    }
  }

  // An npm scope is a registry-enforced namespace, which is the whole
  // justification for prefix matching -- `@sentry/*` is Sentry by
  // construction. Two vendors claiming one namespace means that has stopped
  // holding for at least one of them.
  for (const [scope, owner] of scopeOwners) {
    for (const [other, otherOwner] of scopeOwners) {
      if (other === scope || otherOwner === owner) continue;
      if (other.startsWith(scope)) {
        issues.push({
          vendorId: owner,
          ...issue`package scope "${scope}*" swallows scope "${other}*" claimed by "${otherOwner}"`,
        });
      }
    }
    for (const [pkg, pkgOwner] of packageOwners) {
      if (pkgOwner === owner || pkg.endsWith('/*')) continue;
      if (pkg.startsWith(scope)) {
        issues.push({
          vendorId: owner,
          ...issue`package scope "${scope}*" swallows package alias "${pkg}" claimed by "${pkgOwner}"`,
        });
      }
    }
  }

  // A name that reads as two vendors. `findVendor` answers a bare query by
  // trying it as a vendor id, an npm name, a PyPI name and a host, and refuses
  // when two readings disagree -- so each collision here is a lookup that would
  // silently answer nothing.
  for (const [key, owner] of packageOwners) {
    const [ecosystem, name = ''] = key.split(/:(.*)/s);
    if (name.endsWith('/*')) continue;
    if (vendorIds.has(name) && name !== owner) {
      issues.push({
        vendorId: owner,
        ...issue`package alias "${key}" is the id of vendor "${name}"`,
      });
    }
    if (ecosystem === 'npm') {
      const pypiOwner = packageOwners.get(`pypi:${normalisePypiName(name)}`);
      if (pypiOwner && pypiOwner !== owner) {
        issues.push({
          vendorId: owner,
          ...issue`"${name}" is an npm alias of "${owner}" and a pypi alias of "${pypiOwner}"`,
        });
      }
    }
    for (const [hostKey, hostOwner] of hostOwners) {
      if (hostOwner !== owner && hostKey.split('|')[0] === name) {
        issues.push({
          vendorId: owner,
          ...issue`package alias "${key}" is a host of vendor "${hostOwner}"`,
        });
      }
    }
  }
  return issues;
}

/**
 * DPF records claiming certification with no observed status behind them.
 *
 * A warning rather than an error: the status was never recorded for some
 * entries written before the closed table existed, and each one is a
 * verification task for a maintainer, not a broken file.
 */
export function unobservedDpfRecords(entry: VendorEntry): string[] {
  return entry.legal.transferMechanisms
    .filter((m) => m.mechanism === 'DPF' && m.dpfCertified === true && !m.observedStatus)
    .map((m) => m.url ?? '(no url)');
}

/** Package aliases and host patterns across the set, for the summary line. */
export function aliasCounts(entries: readonly VendorEntry[]): {
  packages: number;
  scopes: number;
  hosts: number;
} {
  const packages = new Set<string>();
  const hosts = new Set<string>();
  let scopes = 0;
  for (const entry of entries) {
    for (const [ecosystem, list] of Object.entries(entry.aliases.packages ?? {})) {
      for (const alias of list ?? []) {
        if (!packages.has(`${ecosystem}:${alias.name}`) && alias.name.endsWith('/*')) scopes++;
        packages.add(`${ecosystem}:${alias.name}`);
      }
    }
    for (const host of entry.aliases.hosts) hosts.add(`${host.pattern}|${host.match}`);
  }
  return { packages: packages.size, scopes, hosts: hosts.size };
}
