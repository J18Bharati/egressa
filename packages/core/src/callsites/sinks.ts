/**
 * The sink table: call shapes whose argument names an outbound destination.
 *
 * Data-driven rather than hard-coded branches, so it is testable and so adding
 * a client library is a one-line change.
 */
export interface SinkDefinition {
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
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request'];
const CLIENT_OBJECTS = ['axios', 'got', 'ky', 'superagent', 'http', 'https', 'undici'];

export const SINKS: SinkDefinition[] = [
  { callee: 'fetch', argIndex: 0, configKeys: ['url'] },
  { callee: 'axios', argIndex: 0, configKeys: ['url', 'baseURL'] },
  { callee: '$fetch', argIndex: 0 },
  { callee: 'ky', argIndex: 0 },
  { callee: 'got', argIndex: 0 },
  { isNew: true, callee: 'URL', argIndex: 0 },
  { isNew: true, callee: 'WebSocket', argIndex: 0 },
  { isNew: true, callee: 'EventSource', argIndex: 0 },
  { isNew: true, callee: 'Request', argIndex: 0 },
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
    if (Boolean(sink.isNew) !== isNew) continue;
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

    sinks.push({ callee: name, argIndex: 0, anyArg: true, configKeys });
    sinks.push({ property: name, argIndex: 0, anyArg: true, configKeys });
  }

  if (anyCallOptions.size > 0) {
    sinks.push({ argIndex: 0, anyArg: true, matchAny: true, configKeys: [...anyCallOptions] });
  }
  return sinks;
}
