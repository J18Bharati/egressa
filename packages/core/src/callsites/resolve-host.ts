/**
 * Static host resolution.
 *
 * The insight that makes this tractable: we need only the *authority*, not the
 * whole URL. `fetch(`https://api.stripe.com/v1/charges/${id}`)` resolves
 * cleanly because the host lives entirely in the first static chunk, even
 * though the rest of the URL is dynamic. Resolving whole URLs would fail on
 * most real code; resolving only the authority succeeds on most of it.
 *
 * What this deliberately does NOT do is guess. When the authority is truncated
 * by an interpolation, or supplied by an environment variable, the outcome is
 * `unresolved` with a reason. Those become transfer/unresolved-egress notes so
 * a human can check the deployment configuration; they never become a vendor
 * attribution.
 */

export type HostResolution =
  | { kind: 'resolved'; host: string }
  | { kind: 'unresolved'; reason: string }
  | { kind: 'not-a-url' };

/** Depth limit for chained constants; keeps this from walking a graph. */
export const MAX_DEPTH = 3;

/** Extracts the authority from a complete URL string, or null if not absolute. */
export function hostFromUrl(value: string): string | null {
  const result = hostFromUrlPrefix(value, false);
  return result.kind === 'resolved' ? result.host : null;
}

/**
 * Extracts the authority from the leading static chunk of a template literal.
 *
 * Returns a host only when the authority is *complete* within that chunk -- that
 * is, when a delimiter (`/`, `?`, `#`) closes it, or the chunk is the whole
 * string. `https://api.` followed by an interpolation has a truncated
 * authority, and resolving it would be a guess.
 */
export function hostFromUrlPrefix(prefix: string, hasMore: boolean): HostResolution {
  // The scheme must start the string. `'/proxy?u=https://api.stripe.com'` is a
  // relative URL whose destination is the app's own origin; a `://` found in
  // its query is not where the request goes.
  //
  // The input is first cleaned the way WHATWG URL parsing cleans it: leading
  // C0 controls and spaces stripped, tabs and newlines removed anywhere, and
  // trailing controls stripped -- the last only when nothing follows, since a
  // prefix's end is not the string's end.
  const input = trimControls(prefix.replace(/[\t\n\r]/g, ''), !hasMore);
  const scheme = SCHEME.exec(input);
  if (!scheme) return { kind: 'not-a-url' };

  const rest = input.slice(scheme[0].length);
  // WHATWG URL parsing ends the authority at a backslash for the special
  // schemes, so `https://api.stripe.com\@evil.example/` is Stripe's host with
  // a path, not evil.example with userinfo.
  const schemeName = scheme[1]?.toLowerCase() ?? '';
  const special = SPECIAL_SCHEMES.has(schemeName);
  const delimiter = rest.search(special ? /[/?#\\]/ : /[/?#]/);

  if (!special) {
    const refusal = connectionUriRefusal(rest, delimiter, hasMore);
    if (refusal) return { kind: 'unresolved', reason: refusal };
  }

  if (delimiter === -1) {
    if (hasMore) {
      return {
        kind: 'unresolved',
        reason: 'host is completed by an interpolated value and cannot be resolved statically',
      };
    }
    return hostOf(schemeName, special, rest);
  }

  return hostOf(schemeName, special, rest.slice(0, delimiter));
}

/**
 * The host of a complete authority. For the special schemes it is read by the
 * WHATWG URL parser itself, which decodes percent-escapes, maps full-width
 * dots, handles IPv6 literals and userinfo, and rejects what `fetch` would
 * reject -- an authority that does not parse has no destination, so nothing
 * is reported for it. Hand-written rules are kept for the other schemes, whose
 * hosts the parser treats as opaque.
 */
function hostOf(scheme: string, special: boolean, authority: string): HostResolution {
  if (authority === '') return { kind: 'not-a-url' };
  if (!special) return { kind: 'resolved', host: normalise(authority) };
  try {
    const host = new URL(`${scheme}://${authority}/`).hostname;
    return host === '' ? { kind: 'not-a-url' } : { kind: 'resolved', host };
  } catch {
    return { kind: 'not-a-url' };
  }
}

/**
 * Why a non-special URI's authority is not its destination, or null when it is.
 *
 * These are connection strings, and their clients do not read them the way
 * WHATWG reads a URL -- or the way each other does. Three shapes make the
 * authority before the first `/`, `?` or `#` a confident wrong host:
 *
 * - A `,` in it. MongoDB's connection string spec and libpq both take a host
 *   list, and the first entry is not the destination.
 * - An `@` after a `?` or `#` and before the next `/`. libpq takes userinfo
 *   up to the first `@` before any `/` and treats neither `?` nor `#` as a
 *   delimiter, so `postgres://a.example:p#w@b.example/` connects to b.example.
 *   An interpolation in that stretch could supply the `@`, so it is refused too.
 * - A `host=` or `hostaddr=` query parameter, which libpq connects to in place
 *   of the authority -- and an interpolation inside the query, which could be one.
 *
 * Refusing is chosen over parsing each scheme as its client does: the refusals
 * are checkable against the specs, and a per-client parser is one more set of
 * hand-written URL rules of the kind that kept producing wrong hosts.
 */
function connectionUriRefusal(rest: string, delimiter: number, hasMore: boolean): string | null {
  const authority = delimiter === -1 ? rest : rest.slice(0, delimiter);
  if (authority.includes(',')) return 'connection URI lists several hosts';
  if (delimiter === -1) return null;

  const tail = rest.slice(delimiter);
  const slash = tail.indexOf('/');
  const beforeSlash = slash === -1 ? tail : tail.slice(0, slash);
  if (beforeSlash.includes('@') || (slash === -1 && hasMore && beforeSlash !== '')) {
    return 'connection URI userinfo is ambiguous: an @ may follow its ? or #';
  }

  const query = tail.indexOf('?');
  if (query === -1) return null;
  const fragment = tail.indexOf('#', query);
  const params = tail.slice(query, fragment === -1 ? undefined : fragment);
  if (/[?&]host(?:addr)?=/i.test(params)) {
    return 'connection URI names its host in a query parameter';
  }
  if (hasMore && fragment === -1) {
    return 'connection URI query is completed by an interpolated value, which may name a host';
  }
  return null;
}

/** C0 controls and space, which WHATWG URL parsing strips from the ends of its input. */
const isControlOrSpace = (code: number) => code <= 0x20;

function trimControls(value: string, trailing: boolean): string {
  let start = 0;
  while (start < value.length && isControlOrSpace(value.charCodeAt(start))) start++;
  let end = value.length;
  if (trailing) while (end > start && isControlOrSpace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/** Schemes WHATWG URL parses with special rules, including `\\` as a delimiter. */
const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp']);

function normalise(authority: string): string {
  let value = authority;
  const at = value.lastIndexOf('@');
  if (at >= 0) value = value.slice(at + 1);
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return (close >= 0 ? value.slice(0, close + 1) : value).toLowerCase();
  }
  const colon = value.indexOf(':');
  if (colon >= 0) value = value.slice(0, colon);
  return value.toLowerCase();
}
