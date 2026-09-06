import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostTrie, normaliseHost } from './host-trie.js';
import type {
  AdequacyDecision,
  AdequacyStatus,
  PackageAlias,
  PackageMatch,
  VendorEntry,
} from './types.js';

export * from './types.js';
export { HostTrie, normaliseHost } from './host-trie.js';

/** Entries older than this are reported as kb/stale-entry rather than as current. */
export const STALE_AFTER_DAYS = 180;

export interface KnowledgeBase {
  version: string;
  vendors: VendorEntry[];
  byId: Map<string, VendorEntry>;
  adequacy: AdequacyStatus;
  lookupPackage(ecosystem: 'npm' | 'pypi', name: string): PackageMatch | null;
  lookupHost(host: string): ReturnType<HostTrie['lookup']>;
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

  return {
    version,
    vendors,
    byId,
    adequacy,

    lookupPackage(ecosystem, name) {
      const exact = packageIndex.get(`${ecosystem}:${name}`);
      if (exact) return exact;
      const key = `${ecosystem}:${name}`;
      for (const { scope, match } of scopeIndex) {
        if (key.startsWith(scope)) return match;
      }
      return null;
    },

    lookupHost(host) {
      return hosts.lookup(host);
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
