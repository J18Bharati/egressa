import { readFileSync } from 'node:fs';
import {
  FACTS_FILE,
  FACTS_MARKER,
  type ScanResult,
  parseFacts,
  scan,
  summarise,
  toSarif,
} from '@egressa/core';
import { describe, expect, it } from 'vitest';
import { formatHuman } from '../packages/cli/src/format/human.js';
import { formatMarkdown } from '../packages/cli/src/format/markdown.js';

/**
 * A repository's `.egressa/facts.json` can change what a scan says, so every
 * surface that renders a scan has to say so too. Until this contract existed
 * only JSON did: SARIF, markdown, the terminal and the MCP summary showed a
 * finding a repository had loosened exactly as if the knowledge base had
 * produced it.
 *
 * Each surface is checked for the same four things, one test per surface and
 * thing, so removing one formatter's marker fails exactly that test:
 * - the run says how many findings depend on the file and how many it loosened;
 * - a loosened finding names the rule it had without the file;
 * - a vendor entry the repository wrote is marked as the repository's;
 * - a DPA URL a repository fact supplies is shown, labelled, and never as the
 *   vendor's own link.
 */

const ROOT = 'fixtures/repos/overlay-dpf';
const SUPPLIED_DPA = 'https://repository-supplied.example/openai-dpa';
const BASELINE = 'transfer/third-country-egress-eu-region-available';

function overlayScan(): ScanResult {
  const file = JSON.parse(readFileSync(`${ROOT}/${FACTS_FILE}`, 'utf8'));
  file.facts.push({
    vendor: 'openai',
    fact: 'dpa',
    value: { available: true, url: SUPPLIED_DPA },
    source: { url: 'https://repository-supplied.example/legal', retrievedAt: '2026-11-03' },
    verifiedBy: 'fixture: a supplied DPA link',
  });
  return scan({
    root: ROOT,
    toolVersion: '0.1.0',
    kbPath: 'kb',
    includeCallsites: true,
    now: new Date('2026-11-10T12:00:00Z'),
    facts: parseFacts(JSON.stringify(file), FACTS_FILE),
    trustFacts: true,
  });
}

const result = overlayScan();
const sarif = toSarif(result, { toolVersion: '0.1.0' }) as {
  runs: {
    properties: { facts?: { headline: string } };
    tool: { driver: { rules: { help: { markdown: string } }[] } };
    results: {
      message: { text: string; markdown: string };
      properties: { vendorId: string | null; baselineRuleId?: string; vendorOrigin?: string };
    }[];
  }[];
};
const run = sarif.runs[0];
if (!run) throw new Error('no SARIF run');
const sarifHelp = run.tool.driver.rules.map((r) => r.help.markdown).join('\n');
const sarifResult = (vendorId: string) =>
  run.results.find((r) => r.properties.vendorId === vendorId);
const human = formatHuman(result, { color: false });
const markdown = formatMarkdown(result);
const summary = summarise(result, { maxFindings: 50 });
const summaryFinding = (vendorId: string) => summary.findings.find((f) => f.vendorId === vendorId);

/** The block of a rendered surface that belongs to one vendor's finding. */
function block(text: string, start: RegExp, next: RegExp): string {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => start.test(l));
  if (from < 0) return '';
  const to = lines.findIndex((l, i) => i > from && next.test(l));
  return lines.slice(from, to < 0 ? undefined : to).join('\n');
}

describe('the fixture exercises every case', () => {
  it('loosens Notion, keeps a local vendor, and applies a supplied DPA link', () => {
    expect(result.facts).toMatchObject({ trusted: true, loosened: 1, localVendors: 1 });
    const notion = result.findings.find((f) => f.vendor?.id === 'notion');
    expect(notion?.baselineRuleId).toBe(BASELINE);
    expect(result.findings.find((f) => f.vendor?.id === 'acme-geo')?.vendor?.origin).toBe('local');
    const openai = result.findings.find((f) => f.vendor?.id === 'openai');
    expect(openai?.transfer?.repositoryFacts?.some((r) => r.suppliedUrl === SUPPLIED_DPA)).toBe(
      true,
    );
    expect(openai?.transfer?.dpaUrl).not.toBe(SUPPLIED_DPA);
  });
});

describe('JSON', () => {
  const json = JSON.parse(JSON.stringify(result)) as ScanResult;
  it('carries the facts summary', () => {
    expect(json.facts?.findingsDependingOnFacts).toBeGreaterThan(0);
  });
  it('names the baseline rule', () => {
    expect(json.findings.find((f) => f.vendor?.id === 'notion')?.baselineRuleId).toBe(BASELINE);
  });
  it('marks the local vendor', () => {
    expect(json.findings.find((f) => f.vendor?.id === 'acme-geo')?.vendor?.origin).toBe('local');
  });
  it('keeps the supplied DPA out of the vendor link', () => {
    expect(json.findings.find((f) => f.vendor?.id === 'openai')?.transfer?.dpaUrl).not.toBe(
      SUPPLIED_DPA,
    );
  });
});

describe('SARIF', () => {
  it('carries the facts summary on the run', () => {
    expect(run.properties.facts?.headline).toContain(FACTS_MARKER);
  });
  it('names the baseline rule and leads the message with the loosening', () => {
    const notion = sarifResult('notion');
    expect(notion?.properties.baselineRuleId).toBe(BASELINE);
    expect(notion?.message.text).toMatch(/^\[loosened by repository-supplied facts\]/);
    expect(notion?.message.text).toContain(BASELINE);
  });
  it('marks the local vendor', () => {
    const local = sarifResult('acme-geo');
    expect(local?.properties.vendorOrigin).toBe('local');
    expect(local?.message.text).toContain(`Vendor entry from ${FACTS_MARKER}`);
  });
  it('shows the supplied DPA as a repository fact, never as the vendor link', () => {
    expect(sarifHelp).toContain('repository-supplied.example/openai-dpa');
    expect(sarifHelp).not.toMatch(/\[Data processing agreement\]\(https:\/\/repository-supplied/);
    expect(sarifResult('openai')?.message.markdown).not.toContain('repository-supplied.example');
  });
});

describe('human output', () => {
  const notion = block(human, /Notion/, /^\S/);
  const local = block(human, /Acme Geo/, /^\S/);
  const openai = block(human, /OpenAI/, /^\S/);
  it('leads with the facts headline', () => {
    expect(human.split('\n')[0]).toContain(FACTS_MARKER);
  });
  it('names the baseline rule', () => {
    expect(notion).toContain(`without them this finding is ${BASELINE}`);
  });
  it('says which way a rule moved', () => {
    expect(notion).toContain('loosened by repository-supplied facts');
    expect(block(human, /Stripe/, /^\S/)).toContain('tightened by repository-supplied facts');
  });
  it('marks the local vendor and its date', () => {
    expect(local).toContain('[local entry]');
    expect(local).toMatch(/verified: +\S+ \(by the repository, not the knowledge base\)/);
  });
  it('shows the supplied DPA on a facts line only', () => {
    const lines = openai.split('\n').filter((l) => l.includes('openai-dpa'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^ +facts: +dpa /);
  });
});

describe('markdown', () => {
  const notion = block(markdown, /^### Notion/, /^### /);
  const local = block(markdown, /^### Acme Geo/, /^### /);
  const openai = block(markdown, /^### OpenAI/, /^### /);
  it('carries the facts headline before the table', () => {
    const headline = markdown.indexOf(FACTS_MARKER);
    expect(headline).toBeGreaterThan(-1);
    expect(headline).toBeLessThan(markdown.indexOf('| Vendor |'));
  });
  it('names the baseline rule', () => {
    expect(notion).toContain(BASELINE);
  });
  it('marks the local vendor and its links', () => {
    expect(local).toContain(`local entry, ${FACTS_MARKER}`);
    expect(local).toContain('(supplied by this repository)');
  });
  it('shows the supplied DPA as a fact, never as the vendor link', () => {
    expect(openai).toMatch(/^- Facts: dpa supplying https:\/\/repository-supplied\.example/m);
    expect(openai).not.toMatch(/\[Data processing agreement\]\(https:\/\/repository-supplied/);
  });
});

describe('MCP summary', () => {
  it('carries the facts summary by default', () => {
    expect(summary.facts?.headline).toContain(FACTS_MARKER);
  });
  it('names the baseline rule', () => {
    expect(summaryFinding('notion')?.baselineRuleId).toBe(BASELINE);
  });
  it('marks the local vendor', () => {
    expect(summaryFinding('acme-geo')?.vendorOrigin).toBe('local');
  });
  it('keeps the supplied DPA out of the vendor link', () => {
    const openai = summaryFinding('openai');
    expect(openai?.dpaUrl).not.toBe(SUPPLIED_DPA);
    expect(openai?.repositoryFacts?.some((r) => r.suppliedUrl === SUPPLIED_DPA)).toBe(true);
  });
});
