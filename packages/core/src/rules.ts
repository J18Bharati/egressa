import type { RuleId, Severity } from './types.js';

export interface RuleDefinition {
  id: RuleId;
  /** Stable camelCase name for SARIF `rules[].name`. */
  name: string;
  shortDescription: string;
  fullDescription: string;
  /** SARIF defaultConfiguration.level. Nothing is `error`: we detect, we do not adjudicate. */
  defaultLevel: Severity;
  /** Rendered into SARIF `help.markdown`, where GitHub shows it in the alert detail. */
  help: string;
  tags: string[];
}

const TAGS = ['gdpr', 'data-transfer', 'third-party'];

export const RULES: Readonly<Record<RuleId, RuleDefinition>> = {
  'transfer/third-country-egress': {
    id: 'transfer/third-country-egress',
    name: 'thirdCountryEgress',
    shortDescription: 'Code references a vendor that processes data outside the EEA.',
    fullDescription:
      'A dependency or call site refers to a vendor whose processing jurisdiction is outside ' +
      'the EEA and is not covered by an in-force adequacy decision. Under GDPR Chapter V such ' +
      'processing requires a transfer mechanism. Adequacy reports the vendor, its jurisdiction ' +
      'and the mechanisms the vendor publishes; it does not determine whether personal data is ' +
      'actually sent, nor whether your use is lawful.',
    defaultLevel: 'warning',
    help:
      'Confirm whether this integration carries personal data. If it does, check the vendor DPA ' +
      'and sub-processor list linked below, and confirm which transfer mechanism you rely on.',
    tags: TAGS,
  },
  'transfer/third-country-egress-eu-region-available': {
    id: 'transfer/third-country-egress-eu-region-available',
    name: 'thirdCountryEgressEuRegionAvailable',
    shortDescription: 'Vendor processes outside the EEA but publishes an EU-hosted option.',
    fullDescription:
      'Same as third-country egress, except the vendor documents an EU region or EU-hosted ' +
      'instance. Adequacy cannot tell from source code which region an account is configured ' +
      'to use, so this is a prompt to verify configuration, not a finding that you are on the ' +
      'non-EU region.',
    defaultLevel: 'warning',
    help:
      'Check which region this account or project is configured to use. The EU-region scope ' +
      'field below records whether that coverage is full, partial, or product-specific.',
    tags: TAGS,
  },
  'transfer/adequate-country-egress': {
    id: 'transfer/adequate-country-egress',
    name: 'adequateCountryEgress',
    shortDescription: 'Vendor processes in a country covered by an adequacy decision.',
    fullDescription:
      'The vendor processes outside the EEA, in a country with an in-force European Commission ' +
      'adequacy decision at the date recorded in the knowledge base. Adequacy decisions are ' +
      'revocable and have been struck down before; the `--assume-adequacy-lapsed` flag re-rates ' +
      'these findings as if the relevant decision were withdrawn.',
    defaultLevel: 'note',
    help:
      'No transfer mechanism is required while the adequacy decision below remains in force. ' +
      'Re-run with --assume-adequacy-lapsed to see the exposure if it is withdrawn.',
    tags: TAGS,
  },
  'transfer/eu-processing': {
    id: 'transfer/eu-processing',
    name: 'euProcessing',
    shortDescription: 'Vendor processes within the EEA.',
    fullDescription:
      'The vendor records EEA processing for this product. Reported for inventory completeness: ' +
      'an EEA-processing vendor is still a processor requiring a DPA under Article 28.',
    defaultLevel: 'note',
    help: 'No Chapter V transfer question arises. A processor agreement is still required.',
    tags: TAGS,
  },
  'transfer/unknown-vendor-egress': {
    id: 'transfer/unknown-vendor-egress',
    name: 'unknownVendorEgress',
    shortDescription: 'Outbound host or package not present in the knowledge base.',
    fullDescription:
      'A resolved outbound host or a dependency was detected but matches no knowledge base ' +
      'entry, so no jurisdiction can be reported. This is a coverage gap in the data, not a ' +
      'statement about the vendor.',
    defaultLevel: 'note',
    help:
      'Adequacy has no entry for this vendor. Consider opening a vendor request so the entry ' +
      'can be added with primary sources.',
    tags: TAGS,
  },
  'transfer/unresolved-egress': {
    id: 'transfer/unresolved-egress',
    name: 'unresolvedEgress',
    shortDescription: 'Outbound call whose host could not be resolved statically.',
    fullDescription:
      'An outbound call was found whose destination is supplied at runtime -- typically from an ' +
      'environment variable or runtime configuration. Adequacy names the variable and reports ' +
      'the location. It never guesses the host.',
    defaultLevel: 'note',
    help:
      'Determine the destination from your deployment configuration. If it is a vendor with a ' +
      'knowledge base entry, the transfer question is the same as for a resolved call.',
    tags: TAGS,
  },
  'kb/stale-entry': {
    id: 'kb/stale-entry',
    name: 'staleKnowledgeBaseEntry',
    shortDescription: 'Knowledge base entry has not been verified recently.',
    fullDescription:
      'The matched vendor entry has a lastVerified date older than the staleness threshold. ' +
      'Vendor hosting, DPAs and sub-processor lists change; a stale entry is reported as stale ' +
      'rather than presented as current.',
    defaultLevel: 'note',
    help: 'Re-verify against the primary sources listed on the entry, and open a correction PR.',
    tags: ['data-quality'],
  },
  'config/expired-suppression': {
    id: 'config/expired-suppression',
    name: 'expiredSuppression',
    shortDescription: 'A suppression in .adequacy.yml has passed its expiry date.',
    fullDescription:
      'Suppressions carry a mandatory expiry so accepted risk is revisited rather than ' +
      'permanently silenced. The underlying finding has been reactivated.',
    defaultLevel: 'note',
    help: 'Review whether the original acceptance still holds, then extend or remove the entry.',
    tags: ['configuration'],
  },
};

export const RULE_IDS = Object.keys(RULES) as RuleId[];

export function getRule(id: RuleId): RuleDefinition {
  const rule = RULES[id];
  if (!rule) throw new Error(`Unknown rule id: ${id}`);
  return rule;
}
