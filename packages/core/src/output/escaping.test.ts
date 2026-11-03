import { describe, expect, it } from 'vitest';
import { formatMarkdown } from '../../../cli/src/format/markdown.js';
import { scan } from '../scan.js';
import type { ScanResult } from '../types.js';
import { markdownUrl } from './display.js';
import { toSarif } from './sarif.js';

// The reader refuses this text in a local entry. These tests hold the output
// layer to it anyway, since the knowledge base path is not the only one that
// could ever put a name or a URL in front of a formatter.
const NAME = 'Relay | US |\n\n## All clear\n\n<img src=x onerror=alert(1)>';
const URL_OUT = 'https://evil.example/dpa)<img/src=x/onerror=alert(1)>';

function hostile(): ScanResult {
  const result = scan({
    root: 'fixtures/repos/overlay-dpf',
    toolVersion: '0.1.0',
    kbPath: 'kb',
    now: new Date('2026-11-10T12:00:00Z'),
    includeCallsites: true,
  });
  const finding = result.findings.find((f) => f.vendor && f.transfer);
  if (!finding?.vendor || !finding.transfer) throw new Error('no vendor finding');
  finding.vendor.name = NAME;
  finding.transfer.dpaUrl = URL_OUT;
  return result;
}

describe('repository text in rendered output', () => {
  it('cannot open a heading, an image or a new table row in markdown', () => {
    const md = formatMarkdown(hostile());
    expect(md).not.toContain('\n## All clear');
    // Escaped as `\\<`, which markdown renders as a literal character.
    expect(md).not.toMatch(/(^|[^\\])<img/);
    expect(md).not.toContain('dpa)<');
  });

  it('cannot do the same in SARIF', () => {
    // Only `markdown` fields are rendered; `text` is plain text by the SARIF spec.
    const markdown: string[] = [];
    JSON.stringify(toSarif(hostile(), { toolVersion: '0.1.0' }), (key, value) => {
      if (key === 'markdown' && typeof value === 'string') markdown.push(value);
      return value;
    });
    expect(markdown.length).toBeGreaterThan(0);
    for (const text of markdown) {
      expect(text).not.toMatch(/(^|[^\\])<img/);
      expect(text).not.toContain('\n## All clear');
      expect(text).not.toContain('dpa)<');
    }
  });

  it('encodes every character that ends a link destination', () => {
    expect(markdownUrl('https://a.example/x (y)<z>')).toBe('https://a.example/x%20%28y%29%3Cz%3E');
  });
});

describe('repository text in human output', () => {
  it('cannot add lines or reorder them', async () => {
    const { formatHuman } = await import('../../../cli/src/format/human.js');
    const result = hostile();
    const finding = result.findings.find((f) => f.vendor);
    if (finding?.vendor) finding.vendor.name = 'Relay‮\n  all clear';
    const text = formatHuman(result, { color: false });
    expect(text).not.toContain('‮');
    expect(text).not.toMatch(/\n {2}all clear/);
  });
});
