import { readFileSync } from 'node:fs';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINDINGS_SCHEMA_VERSION } from './types.js';

/**
 * The forced-binding-failure test the v1 plan specified and the code never had.
 *
 * `oxc-parser` is a native addon. On a platform with no matching prebuild it
 * cannot load, and until this test existed the whole CLI died at module link
 * time -- `engine.degraded` was plumbed through the schema, the summariser and
 * the human formatter while being assigned `false` unconditionally, so the
 * branch was unreachable. `git log -S "degraded = true"` returned nothing for
 * the entire history.
 *
 * Mocking the module to throw reproduces the unsupported-platform case, which
 * is the only way to exercise this without a second machine.
 */

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateFindings = ajv.compile(
  JSON.parse(readFileSync(`schemas/findings-${FINDINGS_SCHEMA_VERSION}.json`, 'utf8')) as object,
);

const NOW = new Date('2026-09-06T12:00:00.000Z');

afterEach(() => {
  vi.doUnmock('oxc-parser');
  vi.resetModules();
});

describe('when the native parser cannot be loaded', () => {
  const scanWithBrokenParser = async () => {
    vi.resetModules();
    vi.doMock('oxc-parser', () => {
      throw new Error('Failed to load native binding');
    });
    const { scan } = await import('./scan.js');
    return scan({
      root: 'fixtures/repos/nextjs-analytics-heavy',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      includeCallsites: true,
      now: NOW,
    });
  };

  it('still produces a schema-valid document rather than crashing', async () => {
    const result = await scanWithBrokenParser();
    const ok = validateFindings(result);
    if (!ok) expect(validateFindings.errors?.slice(0, 5)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('reports the gap instead of hiding it', async () => {
    const result = await scanWithBrokenParser();
    expect(result.scan.engine.degraded).toBe(true);
    expect(result.scan.engine.callsite).toBe('unavailable');
  });

  it('keeps manifest detection working, so the scan is narrower and not empty', async () => {
    const result = await scanWithBrokenParser();
    const kinds = new Set(result.findings.flatMap((f) => f.signals.map((s) => s.kind)));
    expect(kinds.has('dependency')).toBe(true);
    expect(kinds.has('callsite')).toBe(false);
    expect(result.summary.findingCount).toBeGreaterThan(0);
  });

  it('does not claim degradation when call sites were switched off deliberately', async () => {
    // --no-callsites is a user choice, not a platform failure. Conflating them
    // would make every deliberate manifest-only scan look broken.
    vi.resetModules();
    const { scan } = await import('./scan.js');
    const result = scan({
      root: 'fixtures/repos/nextjs-analytics-heavy',
      toolVersion: '0.1.0',
      kbPath: 'kb',
      includeCallsites: false,
      now: NOW,
    });
    expect(result.scan.engine.callsite).toBe('disabled');
    expect(result.scan.engine.degraded).toBe(false);
  });
});
