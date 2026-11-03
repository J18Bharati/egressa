/**
 * `.egressa/facts.json`: legal facts a repository recorded after checking them
 * against a cited source, and vendor entries it drafted for destinations the
 * knowledge base does not know.
 *
 * The file is the scanned repository's, so it is untrusted input in exactly the
 * way `.egressa.yml` is: read through the same hardened reader, parsed
 * strictly, checked against this tool's own bundled schema, and never quoted
 * back. Two kinds of problem are kept apart:
 *
 * - a file that cannot be read as a facts document at all is a `FactsError`,
 *   reported as a usage error on every surface (CLI exit 2, MCP tool error);
 * - one fact that fails is rejected on its own, named by its JSON path, and the
 *   rest still load. One bad line should not discard a team's other checks.
 *
 * Nothing here applies a fact. That is the overlay's job, and it reads only
 * what `checkFacts` returns as current.
 */
import { join } from 'node:path';
import {
  DPF_STATUS_NOT_LISTED,
  DPF_STATUS_QUALIFIED,
  type KnowledgeBase,
  type VendorEntry,
  bundledSchemaIssues,
  collisionIssues,
  dpfStatusVerdict,
  entryIssues,
} from '@egressa/kb';
import { type Node, type ParseError, parseTree, printParseErrorCode } from 'jsonc-parser';
import { findForbiddenClaims } from '../claims.js';
import { expiryInstant } from '../config/index.js';
import { readRepoFile } from '../discovery/read-repo-file.js';

/** Where a repository keeps its facts, relative to the scan root. */
export const FACTS_FILE = '.egressa/facts.json';

/** No agent-verified fact is trusted for longer than this after it was read. */
export const MAX_FACT_AGE_DAYS = 30;

export const FACT_KINDS = ['dpf', 'dpa', 'subprocessors'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface FactSource {
  /** https only. For a `dpf` fact, a page on www.dataprivacyframework.gov. */
  url: string;
  /** The day the page was read, YYYY-MM-DD. */
  retrievedAt: string;
}

export interface DpfFactValue {
  /** The participant record's status, verbatim, or `not-listed`. */
  observedStatus: string;
  organizationName: string;
  /** `.../participant/<id>`, or `.../list` with `not-listed`. */
  participantUrl: string;
}

interface FactBase {
  /** A shipped vendor id, or the id of a local vendor in the same file. */
  vendor: string;
  source: FactSource;
  /** Who checked it: a person, or an agent and the person it worked for. */
  verifiedBy: string;
  /** No later than 30 days after `source.retrievedAt`, which is also the default. */
  expires?: string;
}

export type RepositoryFact =
  | (FactBase & {
      fact: 'dpf';
      value: DpfFactValue;
      /** A named person accepting the qualified status as certified. Never written by an agent. */
      acceptQualifiedStatus?: { acceptedBy: string; reason: string };
    })
  | (FactBase & { fact: 'dpa'; value: { available: boolean; url?: string } })
  | (FactBase & { fact: 'subprocessors'; value: { url: string } });

export interface LocalVendor {
  entry: VendorEntry;
  retrievedAt: string;
  verifiedBy: string;
  expires?: string;
}

/** One item of the file, after its own schema check. */
export type FactsItem =
  | { at: string; kind: 'fact'; fact: RepositoryFact }
  | { at: string; kind: 'local-vendor'; local: LocalVendor }
  | { at: string; kind: 'invalid'; reason: string };

export interface ParsedFacts {
  /** Relative to the scan root, forward slashes. */
  source: string;
  items: FactsItem[];
}

/** A facts file that cannot be read as one. A usage error on every surface. */
export class FactsError extends Error {
  override name = 'FactsError';
}

/** Deeper than any facts document the schema allows; a local entry is about eight levels. */
const MAX_DEPTH = 32;

/**
 * Bounds on what a repository may declare. The set checks a local entry runs
 * against the knowledge base grow with the product of aliases, so an
 * unbounded file is a way to stall a scan, and the MCP server with it.
 */
const MAX_LOCAL_VENDORS = 20;
const MAX_ALIASES = 50;

function sizeProblem(entry: VendorEntry): string | undefined {
  const packages = Object.values(entry.aliases.packages ?? {}).reduce(
    (n, list) => n + (list?.length ?? 0),
    0,
  );
  return entry.aliases.hosts.length > MAX_ALIASES || packages > MAX_ALIASES
    ? `declares more than ${MAX_ALIASES} hosts or packages`
    : undefined;
}

/** The deepest bracket nesting in `text`, outside strings. */
function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') max = Math.max(max, ++depth);
    else if (ch === ']' || ch === '}') depth--;
  }
  return max;
}

/** Larger than any facts file a team writes; the same cap as `.egressa.yml`. */
const MAX_FACTS_BYTES = 8 * 1_048_576;

/** Reads `<root>/.egressa/facts.json`. Null when there is none, which is the normal case. */
export function loadFacts(root: string): ParsedFacts | null {
  const path = join(root, FACTS_FILE);
  const text = readRepoFile(root, path, {
    explicit: false,
    maxBytes: MAX_FACTS_BYTES,
    fail: (message) => new FactsError(message.replace(path, FACTS_FILE)),
  });
  return text === null ? null : parseFacts(text, FACTS_FILE);
}

/**
 * Parses a facts document. `label` names it in messages; it is never the text.
 *
 * Strict JSON, not JSONC: a comment or a trailing comma is an error, so the
 * file a reviewer reads in a diff is the file this reads. A repeated key is an
 * error too -- JSON parsers keep the last one silently, so a reviewer could
 * approve the first value while the second is the one applied.
 */
export function parseFacts(text: string, label: string): ParsedFacts {
  // Every reader below recurses, the parser included, so depth is bounded
  // before any of them runs: a file of nested brackets is a usage error, not
  // a stack overflow reported as an internal one.
  if (nestingDepth(text) > MAX_DEPTH) {
    throw new FactsError(`${label}: nested more than ${MAX_DEPTH} levels deep`);
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  const first = errors[0];
  if (first || !tree) {
    const where = first ? ` at line ${lineOf(text, first.offset)}` : '';
    const what = first ? printParseErrorCode(first.error) : 'empty document';
    throw new FactsError(`${label}: not valid JSON (${what}${where})`);
  }
  const keyProblem = keyProblemIn(tree);
  if (keyProblem) {
    throw new FactsError(
      `${label}: ${keyProblem.problem} at line ${lineOf(text, keyProblem.offset)}`,
    );
  }
  const document = plainValue(tree);

  const issues = bundledSchemaIssues('facts-1.0.0.json', null, document);
  if (issues.length > 0) {
    throw new FactsError(`${label}: ${safeIssue(issues[0] as string)}`);
  }
  const { facts = [], localVendors = [] } = document as {
    facts?: unknown[];
    localVendors?: unknown[];
  };

  const items: FactsItem[] = [];
  for (const [i, raw] of localVendors.entries()) {
    const at = `localVendors[${i}]`;
    const problem =
      bundledSchemaIssues('facts-1.0.0.json', 'localVendor', raw)[0] ??
      bundledSchemaIssues('vendor-1.0.0.json', null, (raw as { entry: unknown }).entry)[0];
    items.push(
      problem
        ? { at, kind: 'invalid', reason: safeIssue(problem) }
        : { at, kind: 'local-vendor', local: raw as LocalVendor },
    );
  }
  for (const [i, raw] of facts.entries()) {
    const at = `facts[${i}]`;
    const kind = (raw as { fact?: unknown }).fact;
    const problem =
      bundledSchemaIssues('facts-1.0.0.json', 'fact', raw)[0] ??
      (kind === 'dpa' || kind === 'subprocessors'
        ? bundledSchemaIssues(
            'facts-1.0.0.json',
            `${kind}Value`,
            (raw as { value: unknown }).value,
          )[0]
        : undefined);
    items.push(
      problem
        ? { at, kind: 'invalid', reason: safeIssue(problem) }
        : { at, kind: 'fact', fact: raw as RepositoryFact },
    );
  }
  return { source: label, items };
}

// ---------------------------------------------------------------------------
// Checking against the knowledge base and the clock
// ---------------------------------------------------------------------------

export type FactState =
  /** Well formed, in date, and naming something it may describe. */
  | 'current'
  /** Past its expiry: ignored, and the knowledge base's own fact stands. */
  | 'expired'
  /** A local entry whose id the shipped knowledge base now has. The shipped entry is used. */
  | 'superseded'
  /** Not used, for the reason given. */
  | 'rejected';

export interface CheckedItem {
  at: string;
  state: FactState;
  /** Present on a current or expired item, never on a rejected one. */
  fact?: RepositoryFact;
  local?: LocalVendor;
  /** The vendor id, when it is a plain name safe to print. */
  vendor?: string;
  /** What the item describes, when it was well formed enough to say. */
  kind?: FactKind | 'local-entry';
  /** The instant it stops being used, YYYY-MM-DD. */
  expiresOn?: string;
  /** Why it was rejected, or a remark on a current one. Never quotes the file. */
  reason?: string;
}

export interface FactsCheck {
  source: string;
  items: CheckedItem[];
}

const DAY = 86_400_000;
/** UTC+14, Kiribati: the furthest any calendar date runs ahead of UTC. */
/**
 * A local entry may only name destinations the shipped knowledge base does
 * not resolve. Exact-key collision is not enough: the host trie prefers an
 * exact pattern and then the deepest suffix, so `bucket.s3.amazonaws.com`
 * would take that host from AWS, and `findSinks()` returns every matching
 * sink, so a constructor on a shipped module would be attributed twice.
 * Messages name the field, never its content.
 */
function shippedClaim(entry: VendorEntry, kb: KnowledgeBase): string | undefined {
  const owner = (id: string | undefined, field: string) =>
    id ? `${field} is already resolved by the knowledge base vendor "${id}"` : undefined;
  for (const [i, host] of entry.aliases.hosts.entries()) {
    const field = `aliases.hosts[${i}]`;
    const found = owner(kb.lookupHost(host.pattern)?.vendor.id, field);
    if (found) return found;
    // A suffix above a shipped host would name that vendor's other hosts
    // under a name the repository chose.
    if (host.match === 'suffix') {
      const below = kb.vendors.find((v) =>
        v.aliases.hosts.some(
          (h) => h.pattern === host.pattern || h.pattern.endsWith(`.${host.pattern}`),
        ),
      );
      if (below) return owner(below.id, field);
    }
  }
  const shippedNames = (ecosystem: string) =>
    kb.vendors.flatMap((v) =>
      ((v.aliases.packages as Record<string, { name: string }[] | undefined>)[ecosystem] ?? []).map(
        (a) => ({ name: a.name, id: v.id }),
      ),
    );
  for (const [ecosystem, list] of Object.entries(entry.aliases.packages ?? {})) {
    if (ecosystem !== 'npm' && ecosystem !== 'pypi') continue;
    for (const [i, alias] of (list ?? []).entries()) {
      const field = `aliases.packages.${ecosystem}[${i}]`;
      const found = alias.name.endsWith('/*')
        ? owner(
            shippedNames(ecosystem).find((p) => p.name.startsWith(alias.name.slice(0, -1)))?.id,
            field,
          )
        : owner(kb.lookupPackage(ecosystem, alias.name)?.vendor.id, field);
      if (found) return found;
    }
  }
  // A named constructor sink matches its export name in any module, and the
  // first vendor's sink to resolve claims the call, so a local `init` would
  // take Sentry's. Constructors are proposed upstream, where they are reviewed.
  if ((entry.aliases.clientConstructors ?? []).length > 0) {
    return 'aliases.clientConstructors: a local vendor cannot declare client constructors; propose them for the knowledge base';
  }
  return undefined;
}

const MAX_ZONE_AHEAD_MS = 14 * 3_600_000;

/**
 * Judges each item against the knowledge base and `now`. Local vendors are
 * checked first, so a fact may describe a local vendor the same file declares.
 */
export function checkFacts(parsed: ParsedFacts, kb: KnowledgeBase, now: Date): FactsCheck {
  const out: CheckedItem[] = [];
  const localIds = new Set<string>();
  const acceptedLocals: VendorEntry[] = [];

  for (const item of parsed.items) {
    if (item.kind === 'invalid') {
      out.push({ at: item.at, state: 'rejected', reason: item.reason });
      continue;
    }
    if (item.kind !== 'local-vendor') continue;
    const { local } = item;
    const id = local.entry.id;
    const base = {
      at: item.at,
      kind: 'local-entry' as const,
      ...(PLAIN.test(id) ? { vendor: id } : {}),
    };
    // Shipped wins. Once a contributed entry ships, the local copy says so
    // rather than failing, so the team knows it can delete it.
    if (kb.byId.has(id)) {
      out.push({
        ...base,
        state: 'superseded',
        reason:
          'the knowledge base has an entry with this id, which is used instead; this one can be deleted',
      });
      continue;
    }
    const timing = timingProblem(local.retrievedAt, local.expires, now);
    const reason =
      timing.reason ??
      textProblem(local) ??
      (localIds.has(id) ? 'repeats the id of an earlier local vendor' : undefined) ??
      (acceptedLocals.length >= MAX_LOCAL_VENDORS
        ? `more than ${MAX_LOCAL_VENDORS} local vendors; contribute some upstream`
        : undefined) ??
      sizeProblem(local.entry) ??
      entryIssues(local.entry)[0]?.redacted ??
      shippedClaim(local.entry, kb) ??
      collisionIssues([...kb.vendors, ...acceptedLocals, local.entry]).find(
        (issue) => issue.vendorId === id,
      )?.redacted;
    if (reason) {
      out.push({ ...base, state: 'rejected', reason: safeIssue(reason) });
      continue;
    }
    localIds.add(id);
    acceptedLocals.push(local.entry);
    out.push({
      ...base,
      local,
      state: timing.expired ? 'expired' : 'current',
      expiresOn: timing.expiresOn,
    });
  }

  const seen = new Map<string, string>();
  for (const item of parsed.items) {
    if (item.kind !== 'fact') continue;
    const { fact } = item;
    // A rejected item carries no content: the check's output is printed and
    // returned over MCP, and a rejected fact is exactly the one not to repeat.
    const base = { at: item.at, vendor: fact.vendor, kind: fact.fact };
    const timing = timingProblem(fact.source.retrievedAt, fact.expires, now);
    const key = `${fact.vendor}|${fact.fact}`;
    const reason =
      (kb.byId.has(fact.vendor) || localIds.has(fact.vendor)
        ? undefined
        : 'names a vendor that is neither in the knowledge base nor a local vendor in this file') ??
      timing.reason ??
      textProblem(fact) ??
      dpfProblem(fact) ??
      (seen.has(key) ? `repeats ${seen.get(key)} for the same vendor and fact` : undefined);
    if (reason) {
      out.push({ ...base, state: 'rejected', reason });
      continue;
    }
    seen.set(key, item.at);
    out.push({
      ...base,
      fact,
      state: timing.expired ? 'expired' : 'current',
      expiresOn: timing.expiresOn,
    });
  }

  const order = new Map(parsed.items.map((item, i) => [item.at, i]));
  out.sort((a, b) => (order.get(a.at) ?? 0) - (order.get(b.at) ?? 0));
  return { source: parsed.source, items: out };
}

/**
 * When a fact stops counting. The 30-day cap is measured from the day the
 * source was read, not from the day the file was written, so copying an old
 * reading into a new commit does not extend it. Dates end at the start of the
 * day in UTC, as suppression expiries do.
 */
function timingProblem(
  retrievedAt: string,
  expires: string | undefined,
  now: Date,
): { reason?: string; expired: boolean; expiresOn: string } {
  const read = expiryInstant(retrievedAt);
  if (read === null) return { reason: 'retrievedAt is not a date', expired: false, expiresOn: '' };
  // A date is written in the reader's own zone and starts at midnight UTC
  // here, so east of UTC today's date begins before UTC reaches it. Up to the
  // largest zone offset ahead is today somewhere, not the future.
  if (read > now.getTime() + MAX_ZONE_AHEAD_MS) {
    return { reason: 'retrievedAt is in the future', expired: false, expiresOn: '' };
  }
  const cap = read + MAX_FACT_AGE_DAYS * DAY;
  let end = cap;
  if (expires !== undefined) {
    const stated = expiryInstant(expires);
    if (stated === null) return { reason: 'expires is not a date', expired: false, expiresOn: '' };
    if (stated > cap) {
      return {
        reason: `expires more than ${MAX_FACT_AGE_DAYS} days after retrievedAt`,
        expired: false,
        expiresOn: '',
      };
    }
    end = stated;
  }
  const expiresOn = new Date(end).toISOString().slice(0, 10);
  return { expired: now.getTime() >= end, expiresOn };
}

function dpfProblem(fact: RepositoryFact): string | undefined {
  if (fact.fact !== 'dpf') {
    return 'acceptQualifiedStatus' in fact
      ? 'acceptQualifiedStatus applies only to a dpf fact'
      : undefined;
  }
  const { observedStatus, participantUrl } = fact.value;
  const notListed = dpfStatusVerdict(observedStatus, false).kind === 'not-listed';
  if (notListed !== participantUrl.endsWith('/list')) {
    return notListed
      ? `"${DPF_STATUS_NOT_LISTED}" cites the list itself, not a participant record`
      : 'a listed status cites a participant record, not the list';
  }
  const verdict = dpfStatusVerdict(observedStatus, fact.acceptQualifiedStatus !== undefined);
  if (fact.acceptQualifiedStatus && verdict.kind !== 'qualified') {
    return `acceptQualifiedStatus applies only to "${DPF_STATUS_QUALIFIED}"`;
  }
  return undefined;
}

/**
 * Every string in the item, checked for control characters and for the words
 * this tool never says. A fact's value reaches every output surface, so it is
 * held to the same vocabulary as the tool's own text.
 */
function textProblem(value: unknown): string | undefined {
  for (const text of strings(value)) {
    // Newlines included: every field is rendered on one line, in a table
    // cell or a heading, and a newline there starts a new block.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control characters
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(text)) {
      return 'contains a control or layout character';
    }
    if (/^https?:/i.test(text) && !SAFE_URL.test(text)) {
      return 'contains a URL with a character that would end a link in rendered output';
    }
    if (findForbiddenClaims(text).length > 0) {
      return 'uses a word this tool does not use about a vendor (see references/language-rules.md)';
    }
  }
  return undefined;
}

/** An https URL with no character that ends a markdown link or an HTML attribute. */
const SAFE_URL = /^https:\/\/[^\s()<>"'`\\[\]{}|^]+$/;

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) yield* strings(v);
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** A value from the file that is safe to quote back: a plain name. */
const PLAIN = /^[a-z0-9-]{1,64}$/;

/** Keys that would reach an object's prototype if assigned. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function keyProblemIn(node: Node): { problem: string; offset: number } | null {
  const children =
    node.type === 'object'
      ? (node.children ?? []).map((property) => property.children?.[1])
      : node.type === 'array'
        ? (node.children ?? [])
        : [];
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = String(property.children?.[0]?.value ?? '');
      if (UNSAFE_KEYS.has(key)) return { problem: 'a reserved key', offset: property.offset };
      if (keys.has(key)) return { problem: 'a repeated key', offset: property.offset };
      keys.add(key);
    }
  }
  for (const child of children) {
    const inner = child ? keyProblemIn(child) : null;
    if (inner) return inner;
  }
  return null;
}

/** Plain data from the tree. Reserved keys were refused above, so no assignment reaches a prototype. */
function plainValue(node: Node): unknown {
  switch (node.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const property of node.children ?? []) {
        const [key, value] = property.children ?? [];
        if (key && value) out[String(key.value)] = plainValue(value);
      }
      return out;
    }
    case 'array':
      return (node.children ?? []).map(plainValue);
    default:
      return node.value;
  }
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * A schema or entry message with anything taken from the file removed, unless
 * it is a plain name. The schema checker names an unexpected key, and the
 * entry checks name package aliases, which the vendor schema does not
 * constrain: both are the file's own text.
 */
function safeIssue(message: string): string {
  // Quoting is not a boundary: a value can contain the quote character, and
  // then pairs match across it. Unless every quoted span is a plain name and
  // nothing outside them holds a quote, everything from the first quote to the
  // last is hidden.
  const spans = [...message.matchAll(/(['"])([^'"]*)\1/g)];
  const rest = message.replace(/(['"])([^'"]*)\1/g, '');
  // A plain name is still the file's word: one the claims contract forbids
  // (a key named `unlawful`) is hidden like any other text.
  const quotable = (text: string) =>
    /^[\w.@/*:$-]{1,80}$/.test(text) && findForbiddenClaims(text).length === 0;
  if (!/['"]/.test(rest) && spans.every((m) => quotable(m[2] ?? ''))) {
    return message;
  }
  const first = message.search(/['"]/);
  const last = Math.max(message.lastIndexOf('"'), message.lastIndexOf("'"));
  const quote = message[first];
  return `${message.slice(0, first)}${quote}(not shown)${quote}${message.slice(last + 1)}`;
}
