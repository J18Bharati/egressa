import { describe, expect, it } from 'vitest';
import { hostFromUrlPrefix } from './resolve-host.js';

/**
 * Connection URIs for the non-special schemes.
 *
 * WHATWG treats their authority as opaque, so `hostOf` reads it by hand -- and
 * the clients that consume them do not agree with WHATWG or with each other.
 * A MongoDB URI lists several hosts (connection string spec); libpq takes the
 * userinfo up to the first `@` before any `/`, ignoring `?` and `#`, and
 * connects to a `host=` or `hostaddr=` query parameter in place of the
 * authority. Each of those is refused rather than parsed per client, because
 * the first host of the list, or the text before the `#`, is a confident
 * wrong host.
 */
const DECLINES: { name: string; input: string; hasMore?: boolean; reason: string }[] = [
  {
    name: 'a MongoDB host list',
    input: 'mongodb://a.example.com:27017,evil.com/',
    reason: 'several hosts',
  },
  {
    name: 'a libpq host list with no path',
    input: 'postgresql://a.example.com,b.example.com',
    reason: 'several hosts',
  },
  {
    name: 'an at-sign after a fragment',
    input: 'postgres://api.stripe.com:p#w@evil.example/',
    reason: 'userinfo',
  },
  {
    name: 'an at-sign after a query',
    input: 'postgres://api.stripe.com?x=@evil.example/db',
    reason: 'userinfo',
  },
  {
    name: 'a host query parameter',
    input: 'postgres://db.example.com/app?host=evil.example',
    reason: 'host',
  },
  {
    name: 'a hostaddr query parameter after another one',
    input: 'postgres://db.example.com/app?sslmode=require&hostaddr=192.0.2.1',
    reason: 'host',
  },
  {
    // The interpolated rest of the query could be `host=...`.
    name: 'a query completed by an interpolation',
    input: 'postgres://db.example.com/app?sslmode=',
    hasMore: true,
    reason: 'query',
  },
  {
    // The interpolation could carry `@evil.example`, which libpq reads as the
    // end of the userinfo.
    name: 'a fragment completed by an interpolation',
    input: 'postgres://db.example.com#',
    hasMore: true,
    reason: 'userinfo',
  },
  {
    // URLSearchParams and libpq both decode a parameter name.
    name: 'a percent-encoded host query parameter',
    input: 'postgres://api.stripe.com/db?%68ost=evil.example',
    reason: 'host',
  },
  {
    // libpq does not end the query at `#`, so host= still applies.
    name: 'a host parameter after a # inside the query',
    input: 'postgres://api.stripe.com/db?x=1#&host=evil.example',
    reason: 'host',
  },
  {
    name: 'a fragment in the query completed by an interpolation',
    input: 'postgres://api.stripe.com/db?sslmode=require#',
    hasMore: true,
    reason: 'query',
  },
  {
    // MongoDB's parser ends the userinfo at the first @: hosts ["evil.example"].
    name: 'two at-signs in the authority',
    input: 'mongodb://u:p@evil.example@api.stripe.com/db',
    reason: 'userinfo',
  },
  {
    // ioredis parses with url.parse, which reads a backslash as a slash.
    name: 'a backslash in the authority',
    input: 'redis://evil.example\\@api.stripe.com/',
    reason: 'backslash',
  },
];

const RESOLVES: { name: string; input: string; hasMore?: boolean; host: string }[] = [
  {
    name: 'a single host with userinfo and a port',
    input: 'postgres://user:pw@db.example.com:5432/x',
    host: 'db.example.com',
  },
  {
    name: 'an at-sign in the path is not userinfo',
    input: 'redis://cache.example.com:6379/0?name=a@b',
    host: 'cache.example.com',
  },
  {
    name: 'a query parameter that only ends in host',
    input: 'postgres://db.example.com/app?ghost=1',
    host: 'db.example.com',
  },
  {
    // Documented in docs/LIMITATIONS.md, "Connection URIs": a possibly
    // incorrect answer, resting on a database name not carrying a query.
    name: 'a path completed by an interpolation',
    input: 'postgres://db.example.com:5432/',
    hasMore: true,
    host: 'db.example.com',
  },
];

describe('hostFromUrlPrefix: non-special connection URIs it must refuse', () => {
  for (const row of DECLINES) {
    it(row.name, () => {
      const result = hostFromUrlPrefix(row.input, row.hasMore ?? false);
      expect(result.kind).toBe('unresolved');
      if (result.kind === 'unresolved') expect(result.reason).toContain(row.reason);
    });
  }
});

describe('hostFromUrlPrefix: non-special connection URIs that still resolve', () => {
  for (const row of RESOLVES) {
    it(row.name, () => {
      expect(hostFromUrlPrefix(row.input, row.hasMore ?? false)).toEqual({
        kind: 'resolved',
        host: row.host,
      });
    });
  }
});

describe('hostFromUrlPrefix: the special schemes are unchanged', () => {
  // These go through WHATWG, which owns `,`, `@` and the query for them.
  it.each([
    ['https://api.stripe.com/v1?host=evil.example', 'api.stripe.com'],
    ['https://user@api.stripe.com/#x@evil.example', 'api.stripe.com'],
    ['wss://api.stripe.com?x=@evil.example', 'api.stripe.com'],
  ])('%s', (input, host) => {
    expect(hostFromUrlPrefix(input, false)).toEqual({ kind: 'resolved', host });
  });
});
