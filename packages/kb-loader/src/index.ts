import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostTrie, normaliseHost } from './host-trie.js';
import { normalisePypiName } from './pypi.js';
import type {
  AdequacyDecision,
  AdequacyStatus,
  PackageAlias,
  PackageMatch,
  VendorEntry,
} from './types.js';

export * from './types.js';
export { HostTrie, normaliseHost } from './host-trie.js';
export { normalisePypiName } from './pypi.js';

/** Entries older than this are reported as kb/stale-entry rather than as current. */
export const STALE_AFTER_DAYS = 180;

export interface KnowledgeBase {
  version: string;
  vendors: VendorEntry[];
  byId: Map<string, VendorEntry>;
  adequacy: AdequacyStatus;
  lookupPackage(ecosystem: 'npm' | 'pypi', name: string): PackageMatch | null;
  lookupHost(host: string): ReturnType<HostTrie['lookup']>;
  /**
   * The vendor a free-text query names: a vendor id, an npm or PyPI package, or
   * a host. Null when nothing matches, or when the npm and PyPI readings name
   * different vendors.
   */
  findVendor(query: string): VendorEntry | null;
  /** In-force adequacy or DPF decision for a country, or null. */
  decisionFor(country: string): AdequacyDecision | null;
  staleEntries(asOf?: Date): VendorEntry[];
}

export interface LoadOptions {
  /** Path to a kb/ directory. Defaults to the bundled one. */
  kbPath?: string;
  /**
   * Countries whose adequacy decision should be treated as withdrawn, to answer
   * "what breaks if adequacy lapses". Values look like "US" or "US:DPF".
   */
  assumeAdequacyLapsed?: string[];
}

export function loadKnowledgeBase(options: LoadOptions = {}): KnowledgeBase {
  const kbPath = options.kbPath ?? defaultKbPath();

  const vendors: VendorEntry[] = readdirSync(join(kbPath, 'vendors'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(kbPath, 'vendors', f), 'utf8')) as VendorEntry)
    .sort((a, b) => a.id.localeCompare(b.id));

  const adequacy = JSON.parse(
    readFileSync(join(kbPath, 'adequacy-status.json'), 'utf8'),
  ) as AdequacyStatus;

  const version = readFileSync(join(kbPath, 'kb.version'), 'utf8').trim();

  // Index by vendor identity, with per-ecosystem aliases pointing at it. Keying
  // on vendor rather than package name is what makes adding another ecosystem a
  // data change rather than a schema change.
  const byId = new Map(vendors.map((v) => [v.id, v]));
  const packageIndex = new Map<string, PackageMatch>();
  const scopeIndex: { scope: string; match: PackageMatch }[] = [];
  const hosts = new HostTrie();

  for (const vendor of vendors) {
    for (const [ecosystem, aliases] of Object.entries(vendor.aliases.packages)) {
      for (const alias of (aliases ?? []) as PackageAlias[]) {
        const match: PackageMatch = { vendor, alias };
        if (alias.name.endsWith('/*')) {
          scopeIndex.push({ scope: `${ecosystem}:${alias.name.slice(0, -1)}`, match });
        } else {
          packageIndex.set(`${ecosystem}:${alias.name}`, match);
        }
      }
    }
    for (const alias of vendor.aliases.hosts) hosts.add(vendor, alias);
  }

  const lapsed = new Set((options.assumeAdequacyLapsed ?? []).map((v) => v.toUpperCase()));

  const kb: KnowledgeBase = {
    version,
    vendors,
    byId,
    adequacy,

    /**
     * Exact aliases win over wildcard scopes, and a name matched by more than
     * one vendor's scope is refused rather than attributed.
     *
     * Returning the first matching scope is the same bug `findSinks()` already
     * had: whichever entry happened to sort first silently shadowed the other.
     * A package index is worse than a sink table to get wrong, because the
     * output names a company. A wrong vendor is worse than no vendor, so the
     * ambiguous case degrades to "unmatched" -- which is visible in
     * `unmatched.packages` -- rather than to a confident misattribution.
     *
     * The validator rejects overlapping scopes outright, so this branch should
     * be unreachable on the shipped knowledge base; it exists because a caller
     * may pass its own `kbPath`.
     */
    lookupPackage(ecosystem, name) {
      // PyPI names are compared in PEP 503 form, the form the knowledge base
      // stores; `Twilio` is the same project as `twilio`. npm names are not
      // normalised, because npm does not treat them as equivalent.
      const key = `${ecosystem}:${ecosystem === 'pypi' ? normalisePypiName(name) : name}`;
      const exact = packageIndex.get(key);
      if (exact) return exact;

      const matched = scopeIndex.filter((entry) => key.startsWith(entry.scope));
      if (matched.length === 0) return null;
      if (new Set(matched.map((entry) => entry.match.vendor.id)).size > 1) return null;

      // One vendor, possibly several of its own scopes: the longest prefix is
      // the most specific statement that vendor makes about the name.
      return matched.reduce((best, entry) =>
        entry.scope.length > best.scope.length ? entry : best,
      ).match;
    },

    lookupHost(host) {
      return hosts.lookup(host);
    },

    /**
     * A question like "is `boto3` a known vendor?" does not say which registry
     * it means. Trying npm alone answered "no entry" for a vendor the knowledge
     * base carries under PyPI. So every reading is tried -- a vendor id in any
     * case, an npm name, a PyPI name, a host -- and when two of them name
     * different vendors the query answers nothing: naming either would be a
     * guess, the same refusal `lookupPackage` makes for two overlapping
     * scopes. The first version let an id win over a package and a package
     * over a host, silently.
     */
    findVendor(query) {
      const lower = query.toLowerCase();
      const readings = [
        byId.get(query) ?? vendors.find((v) => v.id.toLowerCase() === lower),
        kb.lookupPackage('npm', query)?.vendor,
        kb.lookupPackage('pypi', query)?.vendor,
        hosts.lookup(query)?.vendor,
      ].filter((v): v is VendorEntry => v !== undefined);
      const [first] = readings;
      return first && readings.every((v) => v.id === first.id) ? first : null;
    },

    decisionFor(country) {
      const upper = country.toUpperCase();
      const decision = adequacy.decisions.find((d) => d.country.toUpperCase() === upper);
      if (!decision) return null;
      // An assumed-lapsed country is reported as withdrawn, so every downstream
      // rule re-rates without any special-casing of the hypothetical.
      if (lapsed.has(upper) || lapsed.has(`${upper}:${decision.mechanism.toUpperCase()}`)) {
        return { ...decision, status: 'withdrawn' };
      }
      return decision;
    },

    staleEntries(asOf = new Date()) {
      const cutoff = asOf.getTime() - STALE_AFTER_DAYS * 86_400_000;
      return vendors.filter((v) => Date.parse(v.lastVerified) < cutoff);
    },
  };
  return kb;
}

/**
 * The bundled knowledge base. In the published package this sits alongside dist/;
 * in the workspace it is the repo's kb/ directory.
 */
function defaultKbPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'kb'), join(here, '..', '..', '..', 'kb')]) {
    try {
      readFileSync(join(candidate, 'kb.version'), 'utf8');
      return resolve(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('Could not locate the knowledge base. Pass kbPath explicitly.');
}
