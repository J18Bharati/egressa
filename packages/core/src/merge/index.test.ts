import { loadKnowledgeBase } from '@egressa/kb';
import { describe, expect, it } from 'vitest';
import type { Signal } from '../types.js';
import { mergeSignals } from './index.js';

const kb = loadKnowledgeBase({ kbPath: 'kb' });

const signal = (overrides: Partial<Signal>): Signal => ({
  kind: 'infrastructure',
  vendorId: 'aws',
  matchedOn: 'aws',
  confidence: 'high',
  location: { file: 'main.tf', startLine: 2, startColumn: 3, endLine: 2, endColumn: 9 },
  snippet: 'region = "x"',
  ...overrides,
});

const evidenceOf = (signals: Signal[]) => mergeSignals(signals, { kb }).flatMap((f) => f.evidence);

describe('an unmapped region is marked on its evidence', () => {
  it('flags a region the vendor map does not know', () => {
    const [evidence] = evidenceOf([signal({ region: 'eu-wset-1' })]);
    expect(evidence).toMatchObject({ region: 'eu-wset-1', regionUnmapped: true });
  });

  it('does not flag a mapped region', () => {
    const [evidence] = evidenceOf([signal({ region: 'eu-west-1' })]);
    expect(evidence?.region).toBe('eu-west-1');
    expect(evidence).not.toHaveProperty('regionUnmapped');
  });

  it('does not flag a region on a vendor the knowledge base does not hold', () => {
    // No vendor, no map, so nothing for the region to be missing from.
    const [evidence] = evidenceOf([signal({ vendorId: null, matchedOn: 'fly', region: 'ams' })]);
    expect(evidence?.region).toBe('ams');
    expect(evidence).not.toHaveProperty('regionUnmapped');
  });

  it('flags only the unmapped entry in a group it shares with unregioned evidence', () => {
    const findings = mergeSignals(
      [
        signal({ region: 'eu-wset-1' }),
        signal({
          kind: 'dependency',
          matchedOn: '@aws-sdk/client-s3',
          location: {
            file: 'package.json',
            startLine: 5,
            startColumn: 5,
            endLine: 5,
            endColumn: 30,
          },
          snippet: '"@aws-sdk/client-s3": "^3.0.0"',
        }),
      ],
      { kb },
    );
    expect(findings).toHaveLength(1);
    const flagged = findings[0]?.evidence.filter((e) => e.regionUnmapped);
    expect(flagged?.map((e) => e.file)).toEqual(['main.tf']);
  });
});
