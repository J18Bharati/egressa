import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ScanResult, scan, toSarif } from '@egressa/core';
import type { Confidence, Severity } from '@egressa/core';
import { defineCommand } from 'citty';
import { loadConfig } from '../config.js';
import { EXIT } from '../exit-codes.js';
import { formatHuman } from '../format/human.js';
import { formatMarkdown } from '../format/markdown.js';
import { applySuppressions } from '../suppress.js';
import { TOOL_VERSION } from '../version.js';

const SEVERITY_RANK: Record<Severity, number> = { note: 1, warning: 2, error: 3 };
const FAIL_ON = ['none', 'note', 'warning', 'error'] as const;
type FailOn = (typeof FAIL_ON)[number];

export const scanCommand = defineCommand({
  meta: { name: 'scan', description: 'Scan a repository for third-party data egress' },
  args: {
    path: { type: 'positional', required: false, default: '.', description: 'Directory to scan' },
    format: { type: 'string', default: 'human', description: 'human | json | sarif | markdown' },
    out: { type: 'string', description: 'Write output to a file instead of stdout' },
    'fail-on': {
      type: 'string',
      default: 'none',
      description: 'Exit 1 when a finding reaches this level: none | note | warning | error',
    },
    'include-transitive': { type: 'boolean', default: false },
    'no-dev': { type: 'boolean', default: false, description: 'Skip devDependencies' },
    'no-callsites': { type: 'boolean', default: false },
    'no-manifests': { type: 'boolean', default: false },
    'min-confidence': { type: 'string', default: 'low', description: 'low | medium | high' },
    'only-vendor': { type: 'string', description: 'Comma-separated vendor ids' },
    'assume-adequacy-lapsed': {
      type: 'string',
      description: 'Treat these decisions as withdrawn, e.g. US:DPF. Use "all" for every decision.',
    },
    kb: { type: 'string', description: 'Path to a knowledge base directory' },
    config: { type: 'string', description: 'Path to .egressa.yml' },
    'no-color': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
  run({ args }) {
    const root = resolve(String(args.path ?? '.'));
    const failOn = parseFailOn(String(args['fail-on']));
    const config = loadConfig(root, args.config ? String(args.config) : undefined);

    let result: ScanResult;
    try {
      result = scan({
        root,
        toolVersion: TOOL_VERSION,
        ...(args.kb ? { kbPath: String(args.kb) } : {}),
        ...(config.exclude ? { exclude: config.exclude } : {}),
        includeTransitive: Boolean(args['include-transitive']) || config.includeTransitive === true,
        includeDev: !args['no-dev'],
        includeManifests: !args['no-manifests'],
        includeCallsites: !args['no-callsites'],
        minConfidence: parseConfidence(String(args['min-confidence'])),
        ...(args['only-vendor'] ? { onlyVendor: String(args['only-vendor']).split(',') } : {}),
        ...(args['assume-adequacy-lapsed']
          ? { assumeAdequacyLapsed: String(args['assume-adequacy-lapsed']).split(',') }
          : {}),
      });
    } catch (error) {
      process.stderr.write(
        `egressa: could not load the knowledge base: ${(error as Error).message}\n`,
      );
      process.exit(EXIT.KB);
    }

    const suppressed = applySuppressions(result, config);
    const output = render(suppressed, String(args.format), !args['no-color']);

    if (args.out) writeFileSync(String(args.out), `${output}\n`);
    else if (!args.quiet) process.stdout.write(`${output}\n`);

    process.exit(exitCodeFor(suppressed, failOn));
  },
});

function render(result: ScanResult, format: string, color: boolean): string {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'sarif':
      return JSON.stringify(toSarif(result, { toolVersion: TOOL_VERSION }), null, 2);
    case 'markdown':
      return formatMarkdown(result);
    case 'human':
      return formatHuman(result, { color: color && process.stdout.isTTY === true });
    default:
      process.stderr.write(`egressa: unknown format "${format}"\n`);
      process.exit(EXIT.USAGE);
  }
}

/**
 * Default is `none`. A tool that breaks someone's CI the first time they add it,
 * or when a knowledge base update lands through a floating npx version, gets
 * removed that afternoon. The shipped GitHub Action template opts in explicitly.
 */
function exitCodeFor(result: ScanResult, failOn: FailOn): number {
  if (failOn === 'none') return EXIT.CLEAN;
  const threshold = SEVERITY_RANK[failOn];
  const triggered = result.findings.some(
    (f) => !f.suppressed && SEVERITY_RANK[f.severity] >= threshold,
  );
  return triggered ? EXIT.FINDINGS : EXIT.CLEAN;
}

function parseFailOn(value: string): FailOn {
  if ((FAIL_ON as readonly string[]).includes(value)) return value as FailOn;
  process.stderr.write(`egressa: --fail-on must be one of ${FAIL_ON.join(', ')}\n`);
  process.exit(EXIT.USAGE);
}

function parseConfidence(value: string): Confidence {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  process.stderr.write('egressa: --min-confidence must be low, medium or high\n');
  process.exit(EXIT.USAGE);
}
