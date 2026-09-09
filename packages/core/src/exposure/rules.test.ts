import { loadKnowledgeBase } from '@egressa/kb';
import { describe, expect, it } from 'vitest';
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
    expect(exposure.thirdCountryTransfer).toBe(false);
    // This is the population that moves if the framework falls.
    expect(exposure.adequacyDependent).toBe(true);
  });

  it('does NOT clear a US vendor that is not DPF certified', () => {
    // OpenAI's own pages cite SCCs, not DPF; country-level adequacy must not
    // launder that into "covered".
    const { ruleId, exposure } = classifyExposure(vendor('openai'), kb);
    expect(ruleId).toBe('transfer/third-country-egress-eu-region-available');
    expect(exposure.thirdCountryTransfer).toBe(true);
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
    expect(classifyExposure(vendor('sentry'), kb).exposure.rulesVersion).toBe('1.0.0');
  });

  it('treats an under-challenge decision as in force rather than predicting an outcome', () => {
    // US/DPF is under challenge; it still has legal effect today.
    expect(classifyExposure(vendor('mailgun'), kb).ruleId).toBe('transfer/adequate-country-egress');
  });
});
