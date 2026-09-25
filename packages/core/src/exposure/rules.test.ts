import { loadKnowledgeBase } from '@egressa/kb';
import { describe, expect, it } from 'vitest';
import { isUnmappedRegion, resolveRegion } from './regions.js';
import { classifyExposure } from './rules.js';

const kb = loadKnowledgeBase({ kbPath: 'kb' });
const lapsed = loadKnowledgeBase({ kbPath: 'kb', assumeAdequacyLapsed: ['US:DPF'] });
const vendor = (id: string) => {
  const entry = kb.byId.get(id);
  if (!entry) throw new Error(`missing fixture vendor ${id}`);
  return entry;
};

describe('classifyExposure: DPF is not blanket US adequacy', () => {
  it('treats a DPF-certified US vendor as covered by an adequacy decision today', () => {
    const { ruleId, exposure } = classifyExposure(vendor('stripe'), kb);
    expect(ruleId).toBe('transfer/adequate-country-egress');
    // Art 44: still a transfer to a third country. Adequacy is its Art 45
    // basis, which is what additionalSafeguardsRequired records.
    expect(exposure.thirdCountryTransfer).toBe(true);
    expect(exposure.additionalSafeguardsRequired).toBe(false);
    // This is the population that moves if the framework falls.
    expect(exposure.adequacyDependent).toBe(true);
  });

  it('does NOT clear a US vendor that is not DPF certified', () => {
    // OpenAI's own pages cite SCCs, not DPF; country-level adequacy must not
    // launder that into "covered".
    const { ruleId, exposure } = classifyExposure(vendor('openai'), kb);
    expect(ruleId).toBe('transfer/third-country-egress-eu-region-available');
    expect(exposure.thirdCountryTransfer).toBe(true);
    expect(exposure.additionalSafeguardsRequired).toBe(true);
    // An SCC vendor does not move if DPF is withdrawn, so it does not belong
    // in the population that adequacyDependent describes.
    expect(exposure.adequacyDependent).toBe(false);
  });

  it('records the certification check in the audit trail', () => {
    expect(classifyExposure(vendor('stripe'), kb).exposure.inputs).toContain('dpfCertified:true');
    expect(classifyExposure(vendor('openai'), kb).exposure.inputs).toContain('dpfCertified:false');
  });
});

describe('classifyExposure: what breaks if adequacy lapses', () => {
  it('flips a certified US vendor with no EU option to elevated third-country egress', () => {
    const before = classifyExposure(vendor('stripe'), kb);
    const after = classifyExposure(vendor('stripe'), lapsed);

    expect(before.ruleId).toBe('transfer/adequate-country-egress');
    expect(after.ruleId).toBe('transfer/third-country-egress');
    expect(after.exposure.thirdCountryTransfer).toBe(true);
    expect(after.exposure.level).toBe('elevated');
  });

  it('flips a certified vendor that documents an EU region to the addressable rule', () => {
    const after = classifyExposure(vendor('sentry'), lapsed);
    expect(after.ruleId).toBe('transfer/third-country-egress-eu-region-available');
    // Addressable by configuration, so materially different from Stripe's case.
    expect(after.exposure.level).toBe('moderate');
    expect(after.exposure.euAlternativeAvailable).toBe(true);
  });

  it('leaves unaffected countries alone', () => {
    expect(lapsed.decisionFor('JP')?.status).toBe('in-force');
  });

  it('shows the decision status change in the audit trail', () => {
    expect(classifyExposure(vendor('stripe'), kb).exposure.inputs).toContain(
      'decision:US:under-challenge',
    );
    expect(classifyExposure(vendor('stripe'), lapsed).exposure.inputs).toContain(
      'decision:US:withdrawn',
    );
  });
});

describe('classifyExposure: audit trail and versioning', () => {
  it('records the fact tuple it consumed', () => {
    const { exposure } = classifyExposure(vendor('stripe'), kb);
    expect(exposure.inputs).toContain('jurisdiction:US');
    expect(exposure.inputs).toContain('euRegion:none');
    expect(exposure.inputs).toContain('mechanism:DPF');
  });

  it('stamps the rules version that produced the rating', () => {
    expect(classifyExposure(vendor('sentry'), kb).exposure.rulesVersion).toBe('1.2.0');
  });

  it('treats an under-challenge decision as in force rather than predicting an outcome', () => {
    // US/DPF is under challenge; it still has legal effect today.
    expect(classifyExposure(vendor('mailgun'), kb).ruleId).toBe('transfer/adequate-country-egress');
  });
});

describe('classifyExposure: a region selects which jurisdiction applies', () => {
  const aws = vendor('aws');

  it('resolves a region from the vendor map, never from its prefix', () => {
    // The two that matter. Both identifiers begin `eu-`; neither country is in
    // the EEA, and a prefix rule would place both inside it with confidence.
    expect(resolveRegion(aws, 'eu-west-2')?.country).toBe('GB');
    expect(resolveRegion(aws, 'eu-central-2')?.country).toBe('CH');
    expect(resolveRegion(aws, 'eu-west-1')?.country).toBe('IE');
  });

  it('calls a region unmapped only when a vendor map exists and lacks it', () => {
    // One predicate for grouping and evidence. A signal with no knowledge base
    // vendor has no map to be absent from, so it is never flagged.
    expect(isUnmappedRegion(null, 'eu-wset-1')).toBe(false);
    expect(isUnmappedRegion(aws, undefined)).toBe(false);
    expect(isUnmappedRegion(aws, 'eu-west-1')).toBe(false);
    expect(isUnmappedRegion(aws, 'eu-wset-1')).toBe(true);
  });

  it('rates London as an adequate third country, not EU processing', () => {
    const london = classifyExposure(aws, kb, { region: resolveRegion(aws, 'eu-west-2') });
    expect(london.ruleId).toBe('transfer/adequate-country-egress');
    expect(london.exposure.adequacyDependent).toBe(true);
  });

  it('does not clear an EEA region, because the provider entity is still in it', () => {
    // The answer people expect here is eu-processing, and it is wrong. The
    // region moves where customer content sits; it does not remove Amazon Web
    // Services, Inc. from the arrangement, and that jurisdiction is not
    // regionSelected. So choosing Dublin narrows the picture without clearing
    // it -- which is exactly the thing a reader would otherwise get wrong.
    const dublin = classifyExposure(aws, kb, { region: resolveRegion(aws, 'eu-west-1') });
    expect(dublin.ruleId).toBe('transfer/adequate-country-egress');
    expect(dublin.exposure.thirdCountryTransfer).toBe(true);
    // ...but the narrowed set really is different from a US region's.
    const narrowed = dublin.exposure.inputs.find((i) => i.startsWith('narrowedTo:'));
    expect(narrowed).toContain('IE');
    expect(dublin.exposure.inputs).toContain('regionCountry:IE');
  });

  it('records the region and the narrowed set in the audit trail', () => {
    const inputs = classifyExposure(aws, kb, { region: resolveRegion(aws, 'us-east-1') }).exposure
      .inputs;
    expect(inputs).toContain('region:us-east-1');
    expect(inputs).toContain('regionCountry:US');
    expect(inputs).toContain('regionSource:kb');
    // The full known set is still reported alongside the narrowed one.
    expect(inputs).toContain('jurisdiction:EEA');
  });

  it('keeps a jurisdiction the region does not select', () => {
    // Luxembourg is the EMEA contracting entity and is not regionSelected, so
    // it survives narrowing to Dublin. Dropping it would report a clean scan
    // on a contract that still exists.
    const inputs = classifyExposure(aws, kb, { region: resolveRegion(aws, 'eu-west-1') }).exposure
      .inputs;
    expect(inputs.find((i) => i.startsWith('narrowedTo:'))).toContain('LU');
  });

  it('does not narrow on an unknown region, and says so', () => {
    expect(resolveRegion(aws, 'mars-north-1')).toBeNull();
    const inputs = classifyExposure(aws, kb, { unmappedRegions: ['mars-north-1'] }).exposure.inputs;
    expect(inputs).toContain('regionSource:unmapped');
    expect(inputs.some((i) => i.startsWith('narrowedTo:'))).toBe(false);
  });

  it('does not narrow a vendor that has not declared what a region selects', () => {
    // Stripe has no regions map and no regionSelected jurisdiction, so a region
    // handed to it changes nothing.
    const before = classifyExposure(vendor('stripe'), kb);
    const after = classifyExposure(vendor('stripe'), kb, {
      region: { code: 'eu-west-1', country: 'IE', sourceUrl: 'https://example.com' },
    });
    expect(after.ruleId).toBe(before.ruleId);
    expect(after.exposure.inputs).toContain('narrowing:not-declared');
  });
});
