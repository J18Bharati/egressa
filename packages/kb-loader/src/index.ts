import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostTrie, normaliseHost } from './host-trie.js';
import { normalisePypiName } from './pypi.js';
import { type VerifyTask, vendorTasks } from './tasks.js';
import type { AdequacyDecision, AdequacyStatus, PackageMatch, VendorEntry } from './types.js';
import { KnowledgeBaseError, readAdequacy, readText, readVendor } from './validate.js';

export * from './types.js';
export { KnowledgeBaseError } from './validate.js';
export { HostTrie, normaliseHost } from './host-trie.js';
export { normalisePypiName } from './pypi.js';
export * from './dpf-status.js';
export { collisionIssues, entryIssues, type EntryIssue } from './checks.js';
export * from './tasks.js';

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
  /** Legal facts on this entry a person or agent should re-check, as of `asOf`. */
  verifyTasks(entry: VendorEntry, asOf?: Date): VerifyTask[];
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

function isStale(entry: VendorEntry, asOf: Date): boolean {
  return Date.parse(entry.lastVerified) < asOf.getTime() - STALE_AFTER_DAYS * 86_400_000;
}

export function loadKnowledgeBase(options: LoadOptions = {}): KnowledgeBase {
  // The schemas that vouch for the data are the ones this tool shipped with,
  // never the ones beside the data: a supplied knowledge base carrying a
  // permissive schema would otherwise vouch for itself. With no bundled copy
  // there is nothing to check against, so that is a load failure, not a
  // reason to trust the input -- and passing --kb cannot repair it.
  const bundled = bundledKbPath();
  if (bundled === undefined) {
    throw new KnowledgeBaseError(fileURLToPath(import.meta.url), [
      "this tool's own knowledge base and schemas are missing from its installation; reinstall it",
    ]);
  }
  const kbPath = options.kbPath ?? bundled;
  const schemaDir = join(bundled, 'schema');

  const vendorDir = join(kbPath, 'vendors');
  let vendorFiles: string[];
  try {
    vendorFiles = readdirSync(vendorDir).filter((f) => f.endsWith('.json'));
  } catch (error) {
    throw new KnowledgeBaseError(vendorDir, [
      `could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const vendors: VendorEntry[] = vendorFiles
    .map((f) => readVendor(join(vendorDir, f), schemaDir))
    .sort((a, b) => a.id.localeCompare(b.id));

  const adequacy: AdequacyStatus = readAdequacy(join(kbPath, 'adequacy-status.json'), schemaDir);

  const version = readText(join(kbPath, 'kb.version')).trim();

  // Index by vendor identity, with per-ecosystem aliases pointing at it. Keying
  // on vendor rather than package name is what makes adding another ecosystem a
  // data change rather than a schema change.
  const byId = new Map(vendors.map((v) => [v.id, v]));
  const packageIndex = new Map<string, PackageMatch>();
  const scopeIndex: { scope: string; match: PackageMatch }[] = [];
  const hosts = new HostTrie();

  for (const vendor of vendors) {
    for (const [ecosystem, aliases] of Object.entries(vendor.aliases.packages)) {
      for (const alias of aliases ?? []) {
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
      return vendors.filter((v) => isStale(v, asOf));
    },

    verifyTasks(entry, asOf = new Date()) {
      return vendorTasks(entry, {
        stale: isStale(entry, asOf),
        dpfJurisdiction: entry.processing.jurisdictions.some((j) => {
          const decision = kb.decisionFor(j.country);
          return decision?.mechanism === 'DPF' && decision.status !== 'withdrawn';
        }),
      });
    },
  };
  return kb;
}

/**
 * The bundled knowledge base, and with it the schemas every knowledge base is
 * checked against. A built file finds it at `../kb`: the published package,
 * the CLI bundle and the skill bundle all ship it there.
 *
 * The repository's own kb/ is accepted only when this file provably sits in
 * the workspace: three levels up holds pnpm-workspace.yaml and the loader's
 * own source, and this file's path below it is one the workspace builds.
 * Unchecked, the same relative path from an installed
 * `node_modules/egressa/dist` is the *scanned project's* kb/, and from
 * `@egressa/kb/dist` it is an unrelated npm package called `kb` -- either of
 * which would then supply the schemas that vouch for the data. A check on the
 * workspace's *name* was tried first; the scanned project can carry any name.
 *
 * When the loader itself runs from `src/` (vitest aliases it there) the
 * workspace copy is preferred, because `../kb` beside src is a gitignored build
 * copy that goes stale the moment a schema is edited. A built file, including
 * `tsx` resolving `@egressa/kb` to its dist, uses the copy its build made.
 */
function bundledKbPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..', '..', '..');
  const workspaceKb = isThisWorkspace(root, here) ? join(root, 'kb') : undefined;
  const ownKb = join(here, '..', 'kb');
  const candidates = basename(here) === 'src' ? [workspaceKb, ownKb] : [ownKb, workspaceKb];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      readFileSync(join(candidate, 'kb.version'), 'utf8');
      return resolve(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Where a loader file may sit, relative to the workspace root, to use its kb/. */
const WORKSPACE_LOADER_DIRS = new Set([
  'packages/kb-loader/src',
  'packages/kb-loader/dist',
  'packages/cli/dist',
  'packages/mcp/dist',
]);

function isThisWorkspace(root: string, here: string): boolean {
  if (!WORKSPACE_LOADER_DIRS.has(relative(root, here).split(sep).join('/'))) return false;
  try {
    readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
    readFileSync(join(root, 'packages', 'kb-loader', 'src', 'index.ts'), 'utf8');
    return true;
  } catch {
    return false;
  }
}
