import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConfigError,
  type EgressaConfig,
  type ScanResult,
  excludeProblem,
  loadConfig,
  scan,
  toSarif,
} from '@egressa/core';
import type { Confidence, Severity } from '@egressa/core';
import { defineCommand } from 'citty';
import { writeOut } from '../emit.js';
import { EXIT } from '../exit-codes.js';
import { formatHuman } from '../format/human.js';
import { formatMarkdown } from '../format/markdown.js';
import { TOOL_VERSION } from '../version.js';

// citty (via its bundled mri-style parser) only turns a repeated flag into an
// array once it sees a *second* occurrence -- one occurrence yields a plain
// string, zero yields undefined. Verified empirically against the pinned
// citty 0.1.6, not assumed: `parseArgs(['--exclude','a'])` returns a string,
// `parseArgs(['--exclude','a','--exclude','b'])` returns an array.
function toStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

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
    // Declared positively with a `true` default so citty's own `--no-x` negation
    // lands on the key this code reads. Declaring them as `no-dev` instead made
    // citty write `dev: false` while `args['no-dev']` stayed at its default, so
    // every one of these flags parsed cleanly and then did nothing at all.
    dev: {
      type: 'boolean',
      default: true,
      description: 'Include devDependencies (--no-dev skips)',
    },
    callsites: {
      type: 'boolean',
      default: true,
      description: 'Analyse call sites (--no-callsites skips)',
    },
    manifests: {
      type: 'boolean',
      default: true,
      description: 'Analyse dependency manifests (--no-manifests skips)',
    },
    infrastructure: {
      type: 'boolean',
      default: true,
      description: 'Read deployment config for your own regions (--no-infrastructure skips)',
    },
    'min-confidence': { type: 'string', default: 'low', description: 'low | medium | high' },
    'only-vendor': { type: 'string', description: 'Comma-separated vendor ids' },
    'assume-adequacy-lapsed': {
      type: 'string',
      description: 'Treat these decisions as withdrawn, e.g. US:DPF. Use "all" for every decision.',
    },
    kb: { type: 'string', description: 'Path to a knowledge base directory' },
    config: { type: 'string', description: 'Path to .egressa.yml' },
    exclude: {
      type: 'string',
      description:
        'Glob to skip during discovery (repeatable: --exclude a/** --exclude b/**). ' +
        'Adds to, not replacing, any exclude: in .egressa.yml; .egressaignore and .gitignore are honoured too.',
    },
    color: {
      type: 'boolean',
      default: true,
      description: 'Colourise output (--no-color disables)',
    },
    quiet: { type: 'boolean', default: false },
  },
  async run({ args, rawArgs }) {
    const root = resolve(String(args.path ?? '.'));

    // A path that is not a directory is a usage error, not a clean scan. Left
    // unchecked, a typo produces zero findings and an exit code of 0 -- output
    // indistinguishable from a repository that genuinely references no vendor.
    if (!isDirectory(root)) {
      process.stderr.write(`egressa: ${root} is not a directory\n`);
      process.exit(EXIT.USAGE);
    }

    // A config that cannot be honoured is a usage error, like a bad flag -- not
    // an internal failure (exit 3), which is where its throw used to land.
    let config: EgressaConfig;
    try {
      config = loadConfig(root, args.config ? String(args.config) : undefined);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      process.stderr.write(`egressa: ${error.message}\n`);
      process.exit(EXIT.USAGE);
    }
    // citty collects a repeated string flag into an array itself (a second
    // occurrence of --exclude turns the value from a string into string[]);
    // it never appears as an array after exactly one occurrence, so this has
    // to accept string, string[] or undefined. scan() adds these to the
    // config's own excludes rather than replacing them -- .egressa.yml is
    // typically the team's committed baseline (deprecated trees, generated
    // output) and the flag is a one-off narrowing for a single invocation; a
    // user who adds --exclude almost never means "and also stop honouring the
    // team's file". The config's globs were checked when it loaded.
    const exclude = toStringArray(args.exclude);
    const excludeError = excludeProblem(exclude);
    if (excludeError) {
      process.stderr.write(`egressa: ${excludeError}\n`);
      process.exit(EXIT.USAGE);
    }
    // The flag wins over the file, but only when it was actually typed --
    // `--fail-on` carries a default, so its value alone cannot say which.
    const failOnGiven = rawArgs.some((a) => a === '--fail-on' || a.startsWith('--fail-on='));
    const failOn = parseFailOn(
      failOnGiven ? String(args['fail-on']) : (config.failOn ?? String(args['fail-on'])),
    );

    let result: ScanResult;
    try {
      result = scan({
        root,
        toolVersion: TOOL_VERSION,
        ...(args.kb ? { kbPath: String(args.kb) } : {}),
        config,
        ...(exclude.length > 0 ? { exclude } : {}),
        // Only when typed: `false` would override a config that turns it on.
        ...(args['include-transitive'] ? { includeTransitive: true } : {}),
        includeDev: args.dev !== false,
        includeManifests: args.manifests !== false,
        includeInfrastructure: args.infrastructure !== false,
        includeCallsites: args.callsites !== false,
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

    const output = render(result, String(args.format), args.color !== false);

    if (args.out) writeFileSync(String(args.out), `${output}\n`);
    // Awaited, not fire-and-forget: process.exit() below does not flush a
    // pipe, and a truncated findings document is worse than a failed one.
    else if (!args.quiet) await writeOut(`${output}\n`);

    process.exit(exitCodeFor(result, failOn));
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
