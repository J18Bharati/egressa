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

export function findSink(callee: CalleeShape, isNew: boolean): SinkDefinition | null {
  for (const sink of SINKS) {
    if (Boolean(sink.isNew) !== isNew) continue;
    if (sink.object && sink.property) {
      if (callee.object === sink.object && callee.property === sink.property) return sink;
      continue;
    }
    if (sink.callee && callee.name === sink.callee) return sink;
  }
  return null;
}
