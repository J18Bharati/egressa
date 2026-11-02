import { describe, expect, it } from 'vitest';
import { dpfStatusVerdict } from './dpf-status.js';

describe('the closed DPF status table', () => {
  it.each([
    ['Active', false, true, 'active'],
    ['  active ', false, true, 'active'],
    ['Active - Re-certification under Review', false, false, 'qualified'],
    ['Active  -  Re-certification under Review', false, false, 'qualified'],
    ['Active - Re-certification under Review', true, true, 'qualified'],
    ['Inactive', false, false, 'inactive'],
    ['Inactive - Lapse', false, false, 'inactive'],
    ['not-listed', false, false, 'not-listed'],
    // Unknown vocabulary fails closed, including near-misses of "Active".
    ['Active (pending)', false, false, 'unrecognised'],
    ['Actively certified', false, false, 'unrecognised'],
    ['Inactive-Lapse', false, false, 'unrecognised'],
    ['', false, false, 'unrecognised'],
  ])('%j (accepted=%s) is certified=%s, %s', (status, accepted, certified, kind) => {
    expect(dpfStatusVerdict(status, accepted)).toEqual({ certified, kind });
  });

  it('never lets acceptance certify anything but the qualified status', () => {
    for (const status of ['Inactive', 'Inactive - Lapse', 'not-listed', 'Pending']) {
      expect(dpfStatusVerdict(status, true).certified).toBe(false);
    }
  });
});
