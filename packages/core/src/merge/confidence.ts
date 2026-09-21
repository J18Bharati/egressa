import type { PackageAlias } from '@egressa/kb';
import type { Confidence, DependencyRecord, SignalKind } from '../index-types.js';

/**
 * Confidence describes how the signal was obtained. It is deliberately
 * orthogonal to severity, which comes from knowledge base facts about the
 * vendor: a transitive dependency on a US vendor and a resolved call site to
 * the same vendor carry identical severity and very different trust.
 */
export function confidenceForDependency(
  record: Pick<DependencyRecord, 'direct' | 'dev' | 'transitiveVia'>,
  alias: PackageAlias,
): Confidence {
  // Reached through the tree rather than declared: weakest signal there is.
  if (!record.direct) return 'low';
  // A dev-only dependency is real but is not user-data egress from the product.
  if (record.dev) return 'medium';
  // Declaring a vendor's own SDK is the strongest dependency-level statement.
  return alias.kind === 'official-sdk' ? 'high' : 'medium';
}

const ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * The most a signal of this kind is allowed to claim.
 *
 * A `reference` -- `new URL(...)`, `new Request(...)` -- can be read straight
 * off a string literal, which is exactly the observation that earns a call
 * site `high`. But the certainty is about the *string*, not about a transfer:
 * the identical expression parses an inbound request URL or a database DSN.
 * Capping it at `medium` keeps the honest part (this vendor is named here)
 * without letting it present as the strongest evidence in a finding.
 *
 * This is a ceiling, not a value: severity still comes from knowledge base
 * facts about the vendor and is untouched by it. The two axes stay orthogonal.
 */
const CEILING: Partial<Record<SignalKind, Confidence>> = { reference: 'medium' };

/** `raw`, lowered to whatever ceiling this signal kind carries. */
export function confidenceForKind(kind: SignalKind, raw: Confidence): Confidence {
  const ceiling = CEILING[kind];
  if (!ceiling) return raw;
  return ORDER[raw] > ORDER[ceiling] ? ceiling : raw;
}

export function strongest(values: Confidence[]): Confidence {
  return values.reduce<Confidence>((best, v) => (ORDER[v] > ORDER[best] ? v : best), 'low');
}

export function atLeast(value: Confidence, floor: Confidence): boolean {
  return ORDER[value] >= ORDER[floor];
}
