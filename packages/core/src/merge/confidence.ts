import type { PackageAlias } from '@egressa/kb';
import type { Confidence, DependencyRecord } from '../index-types.js';

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

export function strongest(values: Confidence[]): Confidence {
  return values.reduce<Confidence>((best, v) => (ORDER[v] > ORDER[best] ? v : best), 'low');
}

export function atLeast(value: Confidence, floor: Confidence): boolean {
  return ORDER[value] >= ORDER[floor];
}
