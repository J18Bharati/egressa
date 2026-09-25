import type { VendorEntry } from '@egressa/kb';

/**
 * A region identifier resolved to the country it places processing in.
 *
 * `sourceUrl` travels with it so a disputed finding is settled by opening one
 * page, without re-running the scanner.
 */
export interface AppliedRegion {
  code: string;
  country: string;
  sourceUrl: string;
}

/**
 * Resolve a region identifier against a vendor's own published map.
 *
 * Exact match only, case-insensitive and trimmed, and nothing else. No prefix
 * rule, no normalisation, no fallback: three AWS regions whose identifier
 * begins `eu-` are outside the EEA -- London is in the United Kingdom and
 * Zurich is in Switzerland -- so a prefix rule would place both inside it at
 * high confidence. That is the wrong-host failure wearing a different hat, and
 * the whole reason the map is data with a citation rather than a heuristic.
 *
 * Returns null when the identifier is not in the map. The caller must then
 * leave the exposure unnarrowed rather than guess.
 */
export function resolveRegion(vendor: VendorEntry, raw: string): AppliedRegion | null {
  const code = raw.trim().toLowerCase();
  if (code === '') return null;
  const hit = (vendor.regions ?? []).find((r) => r.code.toLowerCase() === code);
  if (!hit) return null;
  return { code: hit.code, country: hit.country.toUpperCase(), sourceUrl: hit.sourceUrl };
}

/**
 * Whether a region was read for a vendor whose map does not know it.
 *
 * True only when there is a vendor and a region and the map has no entry. A
 * signal with no knowledge base vendor has no map to be absent from, so it is
 * never flagged. One predicate, used by grouping and by evidence alike, so a
 * finding's audit trail and its evidence cannot disagree about the same region.
 */
export function isUnmappedRegion(vendor: VendorEntry | null, raw: string | undefined): boolean {
  return vendor !== null && raw !== undefined && resolveRegion(vendor, raw) === null;
}

/**
 * Whether this vendor has declared which of its jurisdictions a region selects.
 *
 * Narrowing is opt-in per jurisdiction. Without at least one `regionSelected`
 * entry there is nothing a region is allowed to replace, and a detected region
 * changes no flag -- which is what keeps every entry authored before this
 * feature behaving exactly as it did.
 */
export function declaresRegionNarrowing(vendor: VendorEntry): boolean {
  return vendor.processing.jurisdictions.some((j) => j.regionSelected === true);
}
