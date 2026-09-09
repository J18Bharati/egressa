import type { AdequacyDecision, KnowledgeBase, VendorEntry } from '@egressa/kb';
import type { Exposure, ExposureLevel, RuleId } from '../types.js';

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
export const EXPOSURE_RULES_VERSION = '1.0.0';

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
export function classifyExposure(vendor: VendorEntry, kb: KnowledgeBase): ExposureResult {
  const countries = vendor.processing.jurisdictions.map((j) => j.country.toUpperCase());
  const nonEea = countries.filter((c) => !EEA_MEMBERS.has(c));
  const euRegion = vendor.processing.euRegion;
  const inputs: string[] = countries.map((c) => `jurisdiction:${c}`);

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
        thirdCountryTransfer: false,
        euAlternativeAvailable: euRegion.available,
        // The whole premise of the tool: this is the population that changes
        // if a decision is withdrawn.
        adequacyDependent: true,
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
      adequacyDependent: decisions.some((d) => d !== null),
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

function flags(input: {
  thirdCountryTransfer: boolean;
  euAlternativeAvailable: boolean;
  adequacyDependent: boolean;
  level: ExposureLevel;
  inputs: string[];
}): Exposure {
  return {
    thirdCountryTransfer: input.thirdCountryTransfer,
    euAlternativeAvailable: input.euAlternativeAvailable,
    adequacyDependent: input.adequacyDependent,
    level: input.level,
    rulesVersion: EXPOSURE_RULES_VERSION,
    inputs: input.inputs,
  };
}
