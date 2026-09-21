import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Exercises the server over a real stdio transport with a real MCP client,
 * rather than calling the handlers directly. The thing most likely to break is
 * the wiring -- transport, schema shapes, serialisation -- not the logic, which
 * lives in core and is tested there.
 */

let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'packages/mcp/src/server.ts'],
    cwd: process.cwd(),
  });
  client = new Client({ name: 'egressa-tests', version: '0' }, { capabilities: {} });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const response = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
  };
  return JSON.parse(response.content[0]?.text ?? '{}');
};

describe('mcp server surface', () => {
  it('exposes exactly the read-only tools, and no write tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_host',
      'check_package',
      'explain_rule',
      'list_vendors',
      'lookup_vendor',
      'scan_repository',
    ]);
  });

  it('carries the claim scope in every tool description', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description).toContain('does not assess or certify GDPR compliance');
    }
  });

  it('offers the transfer-review prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('transfer-review');
  });
});

describe('scan_repository', () => {
  it('returns a token-budgeted summary by default', async () => {
    const result = await call('scan_repository', {
      path: 'fixtures/repos/nextjs-analytics-heavy',
    });
    expect(result.findings.length).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.disclaimer).toContain('does not assess or certify');
    expect(result.kb.version).toBeDefined();
  });

  it('flags truncation so the model knows more is available', async () => {
    const result = await call('scan_repository', {
      path: 'fixtures/repos/nextjs-analytics-heavy',
      maxFindings: 1,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.omittedFindings).toBe(2);
  });

  it('models an adequacy lapse on request', async () => {
    const result = await call('scan_repository', {
      path: 'fixtures/repos/nextjs-analytics-heavy',
      assumeAdequacyLapsed: ['US:DPF'],
    });
    expect(result.assumedAdequacyLapsed).toEqual(['US:DPF']);
    const sentry = result.findings.find((f: { vendorId: string }) => f.vendorId === 'sentry');
    expect(sentry.ruleId).toBe('transfer/third-country-egress-eu-region-available');
  });

  it('narrows the scan when exclude globs are given', async () => {
    // fixtures/repos/nextjs-analytics-heavy has a google-analytics finding
    // backed by exactly one signal: the fetch() call in src/analytics.ts. It
    // has no dependency entry, so excluding that file is the one way to make
    // it disappear entirely rather than merely lose a signal (same fixture
    // and reasoning as the CLI's own --exclude tests).
    const withAll = await call('scan_repository', {
      path: 'fixtures/repos/nextjs-analytics-heavy',
    });
    expect(
      withAll.findings.some((f: { vendorId: string }) => f.vendorId === 'google-analytics'),
    ).toBe(true);

    const excluded = await call('scan_repository', {
      path: 'fixtures/repos/nextjs-analytics-heavy',
      exclude: ['src/analytics.ts'],
    });
    expect(
      excluded.findings.some((f: { vendorId: string }) => f.vendorId === 'google-analytics'),
    ).toBe(false);
    expect(excluded.summary.findingCount).toBeLessThan(withAll.summary.findingCount);
    // openai and sentry are still declared in package.json, so their manifest
    // signal survives losing the call site -- exclude removes what it names,
    // not the vendor everywhere it's mentioned.
    expect(excluded.findings.some((f: { vendorId: string }) => f.vendorId === 'openai')).toBe(true);
    expect(excluded.findings.some((f: { vendorId: string }) => f.vendorId === 'sentry')).toBe(true);
  });
});

describe('reference-only findings are flagged, even after evidence truncation', () => {
  // A dependency entry plus several `new URL(...)` references to the same
  // vendor and no call site at all: `referenceOnly` has to come from the full
  // evidence array, computed before the summariser slices it down to
  // `maxEvidencePerFinding` (3 by default). Five entries forces the slice to
  // actually drop evidence, so this proves the flag survives truncation
  // rather than merely happening to be right on a two-entry fixture.
  const buildFixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'egressa-mcp-reference-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'reference-only',
        version: '1.0.0',
        dependencies: { stripe: '^14.0.0' },
      }),
    );
    writeFileSync(
      join(dir, 'src', 'index.ts'),
      [
        "const a = new URL('https://api.stripe.com/v1/a');",
        "const b = new URL('https://api.stripe.com/v1/b');",
        "const c = new URL('https://api.stripe.com/v1/c');",
        "const d = new URL('https://api.stripe.com/v1/d');",
        'export { a, b, c, d };',
        '',
      ].join('\n'),
    );
    return dir;
  };

  it('flags referenceOnly and reports truncation for the same finding', async () => {
    const path = buildFixture();
    const result = await call('scan_repository', { path });

    const stripe = result.findings.find((f: { vendorId: string }) => f.vendorId === 'stripe');
    expect(stripe).toBeDefined();

    // The fixture proves the point only if truncation actually happened.
    expect(stripe.evidenceTotal).toBe(5);
    expect(stripe.evidence.length).toBeLessThan(stripe.evidenceTotal);
    expect(stripe.evidence.some((e: { kind: string }) => e.kind === 'callsite')).toBe(false);

    // The flag is true even though the truncated evidence array alone -- had
    // a callsite been present and sorted out of the first three -- could not
    // have proven it either way.
    expect(stripe.referenceOnly).toBe(true);
  });
});

describe('vendor lookups', () => {
  it('resolves a package to its vendor with sources attached', async () => {
    const result = await call('check_package', { ecosystem: 'npm', name: '@sentry/nextjs' });
    expect(result.matched).toBe(true);
    expect(result.vendor.name).toContain('Functional Software');
    expect(result.vendor.sources.length).toBeGreaterThan(0);
    expect(result.vendor.lastVerified).toBeDefined();
  });

  it('resolves a host through the suffix trie', async () => {
    const result = await call('check_host', { host: 'o123.ingest.sentry.io' });
    expect(result.matched).toBe(true);
    expect(result.matchedPattern).toBe('ingest.sentry.io');
  });

  it('says plainly when it has no entry, rather than guessing', async () => {
    const result = await call('check_host', { host: 'telemetry.acme.io' });
    expect(result.matched).toBe(false);
    expect(result.note).toContain('No knowledge base entry');
  });

  it('lists vendors with their EU-region scope', async () => {
    const result = await call('list_vendors', {});
    // The roster grows; the shape of each row is what this asserts.
    expect(result.count).toBe(result.vendors.length);
    expect(result.count).toBeGreaterThan(4);
    const sentry = result.vendors.find((v: { id: string }) => v.id === 'sentry');
    expect(sentry.euRegion).toBe('partial');
  });

  it('explains a rule', async () => {
    const result = await call('explain_rule', { ruleId: 'transfer/third-country-egress' });
    expect(result.found).toBe(true);
    expect(result.fullDescription).toContain('Chapter V');
  });
});
