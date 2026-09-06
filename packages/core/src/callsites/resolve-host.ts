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
  const schemeEnd = prefix.indexOf('://');
  if (schemeEnd <= 0) return { kind: 'not-a-url' };

  const rest = prefix.slice(schemeEnd + 3);
  const delimiter = rest.search(/[/?#]/);

  if (delimiter === -1) {
    if (hasMore) {
      return {
        kind: 'unresolved',
        reason: 'host is completed by an interpolated value and cannot be resolved statically',
      };
    }
    return rest === '' ? { kind: 'not-a-url' } : { kind: 'resolved', host: normalise(rest) };
  }

  const authority = rest.slice(0, delimiter);
  return authority === ''
    ? { kind: 'not-a-url' }
    : { kind: 'resolved', host: normalise(authority) };
}

function normalise(authority: string): string {
  let value = authority;
  const at = value.lastIndexOf('@');
  if (at >= 0) value = value.slice(at + 1);
  const colon = value.indexOf(':');
  if (colon >= 0) value = value.slice(0, colon);
  return value.toLowerCase();
}
