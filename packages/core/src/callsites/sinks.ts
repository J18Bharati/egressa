/**
 * The sink table: call shapes whose argument names an outbound destination.
 *
 * Data-driven rather than hard-coded branches, so it is testable and so adding
 * a client library is a one-line change.
 */

/**
 * What a match on this sink proves.
 *
 * `callsite` -- data left here. `reference` -- a vendor is named here, and
 * nothing more: `new URL(...)` and `new Request(...)` parse a string into an
 * object and open no socket. The same shapes appear on an *inbound* request in
 * HTTPS-redirect middleware, and on a database DSN rewritten only to set a
 * query parameter, so treating them as egress inverts the direction the tool
 * reports. The rows stay because the vendor attribution is often right --
 * `new URL(`${GMAIL_API_BASE}/messages`)` before a `fetch` -- and deleting
 * them would lose that.
 */
export type SinkKind = 'callsite' | 'reference';

export interface SinkDefinition {
  /**
   * What a match proves. Absent means `callsite`, which is the default for
   * every genuine client: a new sink is an egress sink unless it says
   * otherwise, so forgetting the field cannot silently under-report.
   */
  kind?: SinkKind;
  /** Bare function call, e.g. `fetch(url)`. */
  callee?: string;
  /** Member call, e.g. `axios.get(url)` or `https.request(url)`. */
  object?: string;
  property?: string;
  /** `new WebSocket(url)`. */
  isNew?: boolean;
  /** Which argument holds the URL. */
  argIndex: number;
  /** When that argument is a config object, the property holding the URL. */
  configKeys?: string[];
  /**
   * Try every argument in order and take the first that yields a destination.
   *
   * Used by knowledge base client constructors, where the position of the URL
   * varies by vendor: `createClient(url, key)` carries it first, while
   * `posthog.init(key, { api_host })` carries it inside the second argument.
   * Recording an index per vendor would put a fact about an SDK's argument
   * order into the data layer, where it would go stale silently.
   */
  anyArg?: boolean;
  /**
   * Match any call shape, relying on `configKeys` alone to select it.
   *
   * A knowledge base entry may record a default export -- `posthog` in
   * `import posthog from 'posthog-js'` -- which is bound to whatever name the
   * importer chose, so there is no callee to match on. What is stable is the
   * option: a call configured with `api_host` is an egress configuration point
   * whoever wrote it.
   *
   * These sinks read *only* config-object arguments. A bare URL passed to an
   * arbitrary function stays a non-sink, which is what keeps
   * `logger.info('https://api.stripe.com/v1')` from becoming a call site.
   */
  matchAny?: boolean;
  /**
   * Config keys carrying a region identifier rather than a host.
   *
   * `new S3Client({ region: 'eu-west-1' })` names a jurisdiction and no host at
   * all, which `configKeys` cannot express: the value is a bare token, not a
   * URL, and `hostFromUrlPrefix` rejects anything without a scheme.
   */
  regionKeys?: string[];
  /**
   * Match whether or not the call used `new`.
   *
   * A knowledge base entry records an export name, not a call form, and the
   * same SDK export is written both ways -- `new S3Client({...})` is the usual
   * shape and `createClient({...})` is not. Filtering these on `isNew` meant
   * every `new`-constructed vendor client was invisible.
   */
  eitherForm?: boolean;
  /**
   * The vendor this sink came from, when it came from a knowledge base entry.
   *
   * A region-only hit has no host to look up, so the attribution has to travel
   * with the sink. Only a sink matched by its own exported name carries one; a
   * catch-all sink spans every vendor and therefore carries none, which is
   * what stops `foo({ region: 'x' })` in unrelated code becoming a finding.
   */
  vendorId?: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request'];
const CLIENT_OBJECTS = ['axios', 'got', 'ky', 'superagent', 'http', 'https', 'undici'];

export const SINKS: SinkDefinition[] = [
  { callee: 'fetch', argIndex: 0, configKeys: ['url'] },
  { callee: 'axios', argIndex: 0, configKeys: ['url', 'baseURL'] },
  { callee: '$fetch', argIndex: 0 },
  { callee: 'ky', argIndex: 0 },
  { callee: 'got', argIndex: 0 },
  // Not egress: a parsed object, no socket. See SinkKind.
  { kind: 'reference', isNew: true, callee: 'URL', argIndex: 0 },
  { isNew: true, callee: 'WebSocket', argIndex: 0 },
  { isNew: true, callee: 'EventSource', argIndex: 0 },
  // Not egress either: `app.handle(new Request(...))` is an in-process
  // dispatch in Elysia and Hono, and the nine `new Request('http://localhost/...')`
  // calls an external reviewer hit were all test-file dispatches.
  { kind: 'reference', isNew: true, callee: 'Request', argIndex: 0 },
];

for (const object of CLIENT_OBJECTS) {
  for (const property of HTTP_METHODS) {
    SINKS.push({ object, property, argIndex: 0, configKeys: ['url', 'baseURL'] });
  }
}

SINKS.push(
  { object: 'axios', property: 'create', argIndex: 0, configKeys: ['baseURL'] },
  { object: 'navigator', property: 'sendBeacon', argIndex: 0 },
);

/** A sink's kind, defaulting to `callsite` when the row does not say. */
export function sinkKind(sink: SinkDefinition): SinkKind {
  return sink.kind ?? 'callsite';
}

export interface CalleeShape {
  name?: string | undefined;
  object?: string | undefined;
  property?: string | undefined;
}

export function findSink(
  callee: CalleeShape,
  isNew: boolean,
  sinks: SinkDefinition[] = SINKS,
): SinkDefinition | null {
  return findSinks(callee, isNew, sinks)[0] ?? null;
}

/**
 * Every sink matching this call shape, most specific first.
 *
 * More than one can match: two vendors may export the same initialiser name,
 * and a catch-all option sink matches everything. Returning all of them lets
 * the caller try each in turn rather than letting whichever sorted first
 * silently shadow the rest -- which is how `posthog.init(key, { api_host })`
 * came to be read against Sentry's `dsn` option and resolve to nothing.
 */
export function findSinks(
  callee: CalleeShape,
  isNew: boolean,
  sinks: SinkDefinition[] = SINKS,
): SinkDefinition[] {
  const named: SinkDefinition[] = [];
  const catchAll: SinkDefinition[] = [];
  for (const sink of sinks) {
    if (sink.matchAny) {
      catchAll.push(sink);
      continue;
    }
    if (!sink.eitherForm && Boolean(sink.isNew) !== isNew) continue;
    if (sink.object && sink.property) {
      if (callee.object === sink.object && callee.property === sink.property) named.push(sink);
      continue;
    }
    // A property with no object matches any receiver: `posthog.init(...)` is
    // written against whatever name the import was bound to.
    if (!sink.object && sink.property) {
      if (callee.property === sink.property) named.push(sink);
      continue;
    }
    if (sink.callee && callee.name === sink.callee) named.push(sink);
  }
  return [...named, ...catchAll];
}

/** A vendor SDK entry point that takes its destination as an argument. */
export interface ClientConstructorSpec {
  /**
   * The package the constructor comes from.
   *
   * Not used for matching -- the analysis is single-file and does not resolve
   * imports -- but carried so the shape matches the knowledge base entry and a
   * caller can pass entries through unchanged.
   */
  module?: string | undefined;
  export?: string | undefined;
  hostOption?: string | null | undefined;
  /** Option carrying a region identifier rather than a host. */
  regionOption?: string | undefined;
}

/**
 * Sinks derived from the knowledge base's `aliases.clientConstructors`.
 *
 * A vendor SDK's own initialiser is where a configured region actually appears
 * -- `posthog.init(key, { api_host: 'https://eu.i.posthog.com' })` is the only
 * place in a repository that says which PostHog cloud is in use. Without these
 * the SDK registers as a dependency signal and the region is invisible.
 *
 * Matching on the exported name alone is deliberately broad, and it is safe
 * because it cannot invent an attribution: a call only becomes a hit when one
 * of its arguments resolves to a real host, and the vendor is then decided by
 * looking that host up, not by which function was called.
 */
export interface VendorConstructors {
  vendorId: string;
  constructors: ClientConstructorSpec[];
}

/**
 * Sinks for every vendor's client constructors.
 *
 * Named sinks carry their vendor so a region read from one can be attributed
 * without a host. The catch-all sink, which exists because a default export is
 * bound to whatever name the importer chose, deliberately does not.
 */
export function vendorConstructorSinks(vendors: VendorConstructors[]): SinkDefinition[] {
  const sinks: SinkDefinition[] = [];
  for (const { vendorId, constructors } of vendors) {
    for (const sink of clientConstructorSinks(constructors)) {
      sinks.push(sink.matchAny ? sink : { ...sink, vendorId });
    }
  }
  return dedupeCatchAll(sinks);
}

/**
 * Collapse the per-vendor catch-all sinks into one with the union of options.
 *
 * A catch-all matches the first call it is offered, so one per vendor would
 * mean the first vendor's option list silently shadowed every other.
 */
function dedupeCatchAll(sinks: SinkDefinition[]): SinkDefinition[] {
  const named = sinks.filter((s) => !s.matchAny);
  const options = new Set(sinks.filter((s) => s.matchAny).flatMap((s) => s.configKeys ?? []));
  if (options.size === 0) return named;
  return [...named, { argIndex: 0, anyArg: true, matchAny: true, configKeys: [...options] }];
}

export function clientConstructorSinks(specs: ClientConstructorSpec[]): SinkDefinition[] {
  const seen = new Set<string>();
  const anyCallOptions = new Set<string>();
  const sinks: SinkDefinition[] = [];
  for (const spec of specs) {
    const name = spec.export ?? 'default';
    const configKeys = spec.hostOption ? [spec.hostOption] : [];
    const key = `${name}|${configKeys.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // A default export has no stable call name. Select on the option instead,
    // and collect every such option into ONE sink: a matchAny sink matches the
    // first call it is offered, so one per vendor would mean the first vendor's
    // option list silently shadowed all the others.
    if (name === 'default') {
      for (const configKey of configKeys) anyCallOptions.add(configKey);
      continue;
    }

    const regionKeys = spec.regionOption ? [spec.regionOption] : [];
    const shape = { argIndex: 0, anyArg: true, eitherForm: true, configKeys, regionKeys };
    sinks.push({ callee: name, ...shape });
    sinks.push({ property: name, ...shape });
  }

  if (anyCallOptions.size > 0) {
    sinks.push({ argIndex: 0, anyArg: true, matchAny: true, configKeys: [...anyCallOptions] });
  }
  return sinks;
}
