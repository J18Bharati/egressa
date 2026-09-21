import type { Finding } from '../types.js';

/**
 * The name shown for a finding whose vendor is null.
 *
 * `buildMessageText()` in `output/sarif.ts` never reached into
 * `evidence[0].matchedOn` for a fallback name, and that turned out to be the
 * right call: for `transfer/unresolved-egress`, `matchedOn` IS the diagnostic
 * sentence explaining why the destination could not be resolved (see
 * `callsites/index.ts`'s `toHit()`, which sets `matchedOn: reason` on the
 * unresolved branch). Three other call sites each grew their own different
 * fallback that promoted that sentence into the vendor slot instead, so a
 * finding with no vendor rendered as a sentence impersonating a company. This
 * is the one fallback string; every renderer calls this instead of inventing
 * its own.
 */
export function displayName(finding: Finding): string {
  return finding.vendor?.name ?? 'Unrecognised destination';
}

/**
 * True when every piece of evidence for this finding is a `reference` --
 * a vendor named in source, never a resolved call site. `merge/index.ts`
 * sorts evidence strongest-first and ranks `callsite` above `reference`, so
 * evidence[0] alone cannot answer this: a finding can carry a `dependency`
 * signal ranked first with a `reference` behind it, and that combination is
 * still missing the one signal (`callsite`) that would say data left.
 *
 * Used so a human reader can see, without opening the JSON, that a finding
 * rests only on a vendor being named -- `new URL(...)`, `new Request(...)` --
 * never on a call that actually left. `docs/LIMITATIONS.md` calls rendering
 * a `reference` like a `callsite` the same defect the engine's own
 * `resolve-host.ts` refuses to commit.
 */
export function isReferenceOnly(finding: Finding): boolean {
  return (
    finding.evidence.some((e) => e.kind === 'reference') &&
    !finding.evidence.some((e) => e.kind === 'callsite')
  );
}
