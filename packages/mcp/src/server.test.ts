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
    expect(result.count).toBe(5);
    const sentry = result.vendors.find((v: { id: string }) => v.id === 'sentry');
    expect(sentry.euRegion).toBe('partial');
  });

  it('explains a rule', async () => {
    const result = await call('explain_rule', { ruleId: 'transfer/third-country-egress' });
    expect(result.found).toBe(true);
    expect(result.fullDescription).toContain('Chapter V');
  });
});
