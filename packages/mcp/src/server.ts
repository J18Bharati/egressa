import { isAbsolute, resolve } from 'node:path';
import {
  ConfigError,
  DISCLAIMER,
  type EgressaConfig,
  FactsError,
  type ParsedFacts,
  RULES,
  RULE_IDS,
  excludeProblem,
  isRuleId,
  loadConfig,
  loadFacts,
  scan,
  summarise,
} from '@egressa/core';
import { loadKnowledgeBase } from '@egressa/kb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * MCP server for Egressa.
 *
 * Deliberately thin: it validates arguments, calls @egressa/core, and shapes
 * the result. There is no analysis logic here at all. Anything that changes
 * behaviour changes in core, and the CLI, this server and the skill all get it
 * at once -- which is the whole point of the findings schema being the real
 * interface rather than the CLI's output.
 *
 * No write tools, no network, no path escape outside the root the caller
 * supplies.
 */

const TOOL_VERSION = '0.2.0';

const server = new McpServer({ name: 'egressa', version: TOOL_VERSION });

/** Every tool description carries the claim scope, not just the README. */
const scoped = (text: string) => `${text}\n\n${DISCLAIMER}`;

function safeRoot(input: string): string {
  const path = isAbsolute(input) ? input : resolve(process.cwd(), input);
  return path;
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

server.tool(
  'scan_repository',
  scoped(
    'Scan a local repository for third-party data egress and cross-border transfer exposure. ' +
      'Returns a summary plus the strongest findings; set full=true for the complete document. ' +
      "The repository's own .egressa.yml is applied, as the CLI applies it: it can exclude files " +
      'and suppress findings. scan.config names the file when there is one, and a suppressed ' +
      'finding is kept and marked suppressed, never removed. Its .egressa/facts.json is applied ' +
      'too: facts that make a finding stricter always, facts that would loosen one only with ' +
      'trustFacts=true, which is for a repository the user owns. Findings computed from those ' +
      'facts carry transfer.repositoryFacts and, when the rule changed, baselineRuleId.',
  ),
  {
    path: z.string().describe('Path to the repository to scan'),
    includeTransitive: z.boolean().optional().describe('Include transitive dependencies'),
    includeDev: z.boolean().optional().describe('Include devDependencies (default true)'),
    minConfidence: z.enum(['low', 'medium', 'high']).optional(),
    maxFindings: z.number().int().positive().optional().describe('Default 20'),
    full: z.boolean().optional().describe('Return the complete findings document'),
    assumeAdequacyLapsed: z
      .array(z.string())
      .optional()
      .describe('Treat these decisions as withdrawn, e.g. ["US:DPF"], to model an adequacy lapse'),
    exclude: z
      .array(z.string())
      .optional()
      .describe('Globs to skip during discovery, e.g. ["vendor/**", "**/legacy/**"]'),
    trustFacts: z
      .boolean()
      .optional()
      .describe(
        "Apply facts in the repository's .egressa/facts.json that would loosen a finding. " +
          'Set only when the user owns the repository; never inferred from the repository.',
      ),
  },
  async (args) => {
    const excludeError = excludeProblem(args.exclude ?? []);
    if (excludeError) {
      return { content: [{ type: 'text' as const, text: excludeError }], isError: true };
    }
    const root = safeRoot(args.path);
    let config: EgressaConfig;
    try {
      config = loadConfig(root);
    } catch (error) {
      const message = (error as Error).message;
      const text = error instanceof ConfigError ? message : `.egressa.yml: ${message}`;
      return { content: [{ type: 'text' as const, text }], isError: true };
    }
    let facts: ParsedFacts | null;
    try {
      facts = loadFacts(root);
    } catch (error) {
      if (!(error instanceof FactsError)) throw error;
      return { content: [{ type: 'text' as const, text: error.message }], isError: true };
    }
    const result = scan({
      root,
      toolVersion: TOOL_VERSION,
      config,
      facts,
      trustFacts: args.trustFacts === true,
      includeCallsites: true,
      ...(args.includeTransitive !== undefined
        ? { includeTransitive: args.includeTransitive }
        : {}),
      ...(args.includeDev !== undefined ? { includeDev: args.includeDev } : {}),
      ...(args.minConfidence ? { minConfidence: args.minConfidence } : {}),
      ...(args.assumeAdequacyLapsed ? { assumeAdequacyLapsed: args.assumeAdequacyLapsed } : {}),
      ...(args.exclude ? { exclude: args.exclude } : {}),
    });

    if (args.full === true) return json(result);
    return json(summarise(result, args.maxFindings ? { maxFindings: args.maxFindings } : {}));
  },
);

server.tool(
  'lookup_vendor',
  scoped(
    'Look up a vendor in the knowledge base by id, npm or PyPI package name, or hostname. ' +
      'Returns the full sourced entry including its citations and last-verified date.',
  ),
  { query: z.string().describe('Vendor id, package name, or host') },
  async ({ query }) => {
    const kb = loadKnowledgeBase();
    const entry = kb.findVendor(query);

    if (!entry) {
      return json({
        found: false,
        query,
        note: 'No knowledge base entry exists for this vendor, so no jurisdiction can be reported.',
        disclaimer: DISCLAIMER,
      });
    }
    return json({ found: true, vendor: entry, disclaimer: DISCLAIMER });
  },
);

server.tool(
  'list_vendors',
  scoped('List the vendors in the knowledge base, optionally filtered by category.'),
  { category: z.string().optional() },
  async ({ category }) => {
    const kb = loadKnowledgeBase();
    const vendors = kb.vendors
      .filter((v) => !category || v.category === category)
      .map((v) => ({
        id: v.id,
        name: v.name,
        category: v.category,
        jurisdictions: v.processing.jurisdictions.map((j) => j.country),
        euRegion: v.processing.euRegion.available
          ? (v.processing.euRegion.scope ?? 'available')
          : 'not documented',
        lastVerified: v.lastVerified,
      }));
    return json({ kbVersion: kb.version, count: vendors.length, vendors, disclaimer: DISCLAIMER });
  },
);

server.tool(
  'check_package',
  scoped(
    'Check a package before installing it: does it belong to a known vendor, and what is that ' +
      "vendor's transfer position? Answers the pre-install question without scanning a repo.",
  ),
  {
    ecosystem: z.enum(['npm', 'pypi']).default('npm'),
    name: z.string().describe('Package name, e.g. @sentry/nextjs'),
  },
  async ({ ecosystem, name }) => {
    const kb = loadKnowledgeBase();
    const match = kb.lookupPackage(ecosystem, name);
    if (!match) {
      return json({
        matched: false,
        name,
        note: 'No knowledge base entry.',
        disclaimer: DISCLAIMER,
      });
    }
    return json({
      matched: true,
      name,
      aliasKind: match.alias.kind,
      vendor: {
        id: match.vendor.id,
        name: match.vendor.name,
        jurisdictions: match.vendor.processing.jurisdictions.map((j) => j.country),
        euRegion: match.vendor.processing.euRegion,
        dpaUrl: match.vendor.legal.dpa.url,
        subprocessorsUrl: match.vendor.legal.subprocessors?.url,
        transferMechanisms: match.vendor.legal.transferMechanisms,
        sources: match.vendor.sources,
        lastVerified: match.vendor.lastVerified,
      },
      disclaimer: DISCLAIMER,
    });
  },
);

server.tool(
  'check_host',
  scoped('Check a hostname against the knowledge base and report the vendor and jurisdiction.'),
  { host: z.string() },
  async ({ host }) => {
    const kb = loadKnowledgeBase();
    const match = kb.lookupHost(host);
    if (!match) {
      return json({
        matched: false,
        host,
        note: 'No knowledge base entry.',
        disclaimer: DISCLAIMER,
      });
    }
    return json({
      matched: true,
      host,
      matchedPattern: match.alias.pattern,
      purpose: match.alias.purpose,
      vendor: {
        id: match.vendor.id,
        name: match.vendor.name,
        jurisdictions: match.vendor.processing.jurisdictions.map((j) => j.country),
        euRegion: match.vendor.processing.euRegion,
        sources: match.vendor.sources,
        lastVerified: match.vendor.lastVerified,
      },
      disclaimer: DISCLAIMER,
    });
  },
);

server.tool(
  'explain_rule',
  scoped('Explain what a rule id means and how it is derived from knowledge base facts.'),
  { ruleId: z.string().optional().describe('Omit to list every rule id') },
  async ({ ruleId }) => {
    if (!ruleId) return json({ rules: RULE_IDS, disclaimer: DISCLAIMER });
    if (!isRuleId(ruleId)) {
      return json({ found: false, ruleId, rules: RULE_IDS, disclaimer: DISCLAIMER });
    }
    const rule = RULES[ruleId];
    return json({
      found: true,
      id: rule.id,
      shortDescription: rule.shortDescription,
      fullDescription: rule.fullDescription,
      defaultLevel: rule.defaultLevel,
      help: rule.help,
      disclaimer: DISCLAIMER,
    });
  },
);

server.prompt(
  'transfer-review',
  'Review a repository for cross-border data transfer exposure and summarise it honestly.',
  { path: z.string().describe('Repository path to review') },
  ({ path }) => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Scan ${path} with the scan_repository tool, then review the findings.`,
            '',
            'When you summarise:',
            '- Open the evidence files and check whether each call site is live production code',
            '  rather than a test, an example, or a dead branch. The scanner cannot tell.',
            '- Report what the knowledge base records, and cite the lastVerified date.',
            '- For any unresolved-egress finding, say which environment variable supplies the',
            '  host and that the destination must be checked in deployment configuration.',
            '- Never state or imply that the repository is or is not GDPR compliant, that a',
            '  transfer is unlawful, or that a clean scan proves anything beyond the absence of',
            '  detected patterns.',
            '',
            DISCLAIMER,
          ].join('\n'),
        },
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
