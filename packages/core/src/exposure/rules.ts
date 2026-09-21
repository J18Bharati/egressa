import type { AdequacyDecision, KnowledgeBase, VendorEntry } from '@egressa/kb';
import type { Exposure, ExposureLevel, RuleId } from '../types.js';
import { type AppliedRegion, declaresRegionNarrowing } from './regions.js';

/**
 * The exposure rule table.
 *
 * Exposure is computed here from knowledge base facts, never authored in the
 * data. That has a specific consequence for disputes: a vendor objecting to
 * `thirdCountryTransfer: true` is objecting either to a fact -- settled by
 * opening the cited URL -- or to a rule published in docs/METHODOLOGY.md.
 * Neither is a matter of opinion about the vendor.
 *
 * Bump EXPOSURE_RULES_VERSION whenever the mapping below changes, so a stored
 * finding records which version produced it.
 */
export const EXPOSURE_RULES_VERSION = '1.2.0';

const EEA_MEMBERS = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
  'EEA',
]);

export interface ExposureResult {
  exposure: Exposure;
  ruleId: RuleId;
}

/**
 * Classify a vendor's transfer exposure.
 *
 * The flags are the output that matters; `level` is a derived ordinal offered
 * for sorting and summary lines only.
 */
export interface ExposureContext {
  /** The region this vendor was configured with, when one was detected and resolved. */
  region?: AppliedRegion | null;
  /** A region identifier that was detected but is not in the vendor's map. */
  unmappedRegion?: string | null;
}

export function classifyExposure(
  vendor: VendorEntry,
  kb: KnowledgeBase,
  context: ExposureContext = {},
): ExposureResult {
  const known = vendor.processing.jurisdictions.map((j) => j.country.toUpperCase());
  const euRegion = vendor.processing.euRegion;

  // The full set is always reported, so a reader sees what was known as well as
  // what was evaluated.
  const inputs: string[] = known.map((c) => `jurisdiction:${c}`);

  // Narrowing is opt-in per jurisdiction and replaces only the jurisdictions an
  // author marked as region selected. A contracting entity survives: a project
  // hosted in Frankfurt is still contracted with the entity in the addendum,
  // and dropping it because a region was detected would report a clean scan on
  // a transfer that is really happening.
  const region = context.region ?? null;
  const narrows = region !== null && declaresRegionNarrowing(vendor);
  const countries = narrows
    ? [
        region.country,
        ...vendor.processing.jurisdictions
          .filter((j) => j.regionSelected !== true)
          .map((j) => j.country.toUpperCase()),
      ]
    : known;

  if (region) {
    inputs.push(`region:${region.code}`, `regionCountry:${region.country}`, 'regionSource:kb');
    if (narrows) inputs.push(`narrowedTo:${[...new Set(countries)].sort().join(',')}`);
    // A resolved region against an entry that never declared which jurisdiction
    // it selects changes nothing, and saying so is more useful than silence.
    else inputs.push('narrowing:not-declared');
  } else if (context.unmappedRegion) {
    inputs.push(`region:${context.unmappedRegion}`, 'regionSource:unmapped');
  } else {
    inputs.push('regionSource:none');
  }

  const nonEea = countries.filter((c) => !EEA_MEMBERS.has(c));

  inputs.push(`euRegion:${euRegion.available ? (euRegion.scope ?? 'unscoped') : 'none'}`);
  for (const mechanism of vendor.legal.transferMechanisms) {
    inputs.push(`mechanism:${mechanism.mechanism}`);
  }

  // All processing inside the EEA: no Chapter V question arises.
  if (nonEea.length === 0) {
    return {
      ruleId: 'transfer/eu-processing',
      exposure: flags({
        thirdCountryTransfer: false,
        euAlternativeAvailable: euRegion.available,
        adequacyDependent: false,
        additionalSafeguardsRequired: false,
        level: 'none',
        inputs,
      }),
    };
  }

  // Is every non-EEA jurisdiction covered by a decision that both is in force
  // and actually applies to THIS vendor?
  const decisions = nonEea.map((country) => kb.decisionFor(country));
  const allCovered =
    decisions.length > 0 && decisions.every((d) => d !== null && covers(d, vendor));
  for (const [i, decision] of decisions.entries()) {
    inputs.push(`decision:${nonEea[i]}:${decision ? decision.status : 'none'}`);
    if (decision?.mechanism === 'DPF') {
      inputs.push(`dpfCertified:${vendorIsDpfCertified(vendor)}`);
    }
  }

  if (allCovered) {
    return {
      ruleId: 'transfer/adequate-country-egress',
      exposure: flags({
        // Art 44: a transfer to an adequate country is still a third-country
        // transfer. Art 45 supplies its legal basis; it does not undo the fact.
        thirdCountryTransfer: true,
        euAlternativeAvailable: euRegion.available,
        // The whole premise of the tool: this is the population that changes
        // if a decision is withdrawn.
        adequacyDependent: true,
        // Adequacy is the mechanism, so nothing under Art 46 is added.
        additionalSafeguardsRequired: false,
        level: 'low',
        inputs,
      }),
    };
  }

  const euAlternative = euRegion.available;
  return {
    ruleId: euAlternative
      ? 'transfer/third-country-egress-eu-region-available'
      : 'transfer/third-country-egress',
    exposure: flags({
      thirdCountryTransfer: true,
      euAlternativeAvailable: euAlternative,
      // Not `decisions.some(...)`: a decision merely existing for the country
      // says nothing about this vendor. A US vendor relying on SCCs rather than
      // DPF is unaffected by DPF being withdrawn, and reporting it as adequacy
      // dependent puts it in the "what breaks if adequacy falls" list wrongly.
      adequacyDependent: false,
      additionalSafeguardsRequired: true,
      // A documented EU alternative means the exposure is addressable by
      // configuration, which is materially different from one that is not.
      level: euAlternative ? 'moderate' : 'elevated',
      inputs,
    }),
  };
}

/**
 * `under-challenge` counts as in force: the decision still has legal effect and
 * saying otherwise would be a prediction about litigation. The challenge is
 * surfaced through the decision's own notes instead.
 */
function isInForce(decision: AdequacyDecision): boolean {
  return decision.status === 'in-force' || decision.status === 'under-challenge';
}

/**
 * Whether a decision actually covers this vendor.
 *
 * Country-level adequacy (Japan, Switzerland, ...) covers every recipient in
 * that country. The EU-US Data Privacy Framework does not: it covers only
 * organisations that have self-certified and appear on the DPF list. Treating
 * DPF as blanket US adequacy would wrongly clear every US vendor -- including
 * ones whose own pages cite standard contractual clauses precisely because they
 * are not certified.
 */
function covers(decision: AdequacyDecision, vendor: VendorEntry): boolean {
  if (!isInForce(decision)) return false;
  if (decision.mechanism === 'DPF') return vendorIsDpfCertified(vendor);
  return true;
}

function vendorIsDpfCertified(vendor: VendorEntry): boolean {
  return vendor.legal.transferMechanisms.some(
    (m) => m.mechanism === 'DPF' && m.dpfCertified === true,
  );
}

/**
 * Stamps the rules version onto a flag set.
 *
 * Takes `Omit<Exposure, 'rulesVersion'>` rather than a hand-listed shape so a
 * new flag cannot be silently dropped on the way out -- an earlier version
 * listed the fields twice and quietly discarded any field added to only one.
 */
function flags(input: Omit<Exposure, 'rulesVersion'>): Exposure {
  return { ...input, rulesVersion: EXPOSURE_RULES_VERSION };
}
