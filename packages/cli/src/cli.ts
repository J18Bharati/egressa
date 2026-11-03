import { type ArgsDef, defineCommand, runCommand, runMain } from 'citty';
import { explainCommand } from './commands/explain.js';
import { factsCommand } from './commands/facts.js';
import { scanCommand } from './commands/scan.js';
import { schemaCommand } from './commands/schema.js';
import { vendorsCommand } from './commands/vendors.js';
import { EXIT } from './exit-codes.js';
import { flagProblems } from './flags.js';
import { TOOL_VERSION } from './version.js';

const subCommands = {
  scan: scanCommand,
  vendors: vendorsCommand,
  explain: explainCommand,
  schema: schemaCommand,
  facts: factsCommand,
};

const main = defineCommand({
  meta: {
    name: 'egressa',
    // citty answers `--version` from here, and exits 1 with "No version
    // specified" when it is missing -- which it was, although `--version` has
    // always been in PASS_THROUGH below.
    version: TOOL_VERSION,
    description:
      'Detects third-party data-egress patterns in source code and their cross-border ' +
      'transfer exposure. Does not assess or certify GDPR compliance.',
  },
  subCommands,
  args: scanCommand.args,
});

/** Names that must reach citty untouched rather than being read as a path. */
const PASS_THROUGH = new Set(['--help', '-h', '--version', '-v']);

/**
 * `egressa .` and `egressa --quiet` mean `egressa scan`.
 *
 * citty resolves the first positional against the subcommand table before a
 * parent's own `run` is reachable, so a bare path exits with "Unknown command"
 * no matter what the parent does. Rewriting argv is what makes the documented
 * default work.
 *
 * Doing it here also lets the parent command drop its fallback `run`. citty
 * executes a parent's `run` *in addition to* the matched subcommand, so that
 * fallback fired a second, spurious scan after every `explain` and `vendors` --
 * scanning the subcommand's own name as though it were a path.
 */
export function withDefaultCommand(argv: string[]): string[] {
  const first = argv[0];
  if (first === undefined) return ['scan'];
  // citty answers a version request only when argv is exactly `['--version']`,
  // so `-v` printed usage and exited 1 -- the "findings" code.
  if (first === '-v' && argv.length === 1) return ['--version'];
  if (Object.hasOwn(subCommands, first) || PASS_THROUGH.has(first)) return argv;
  return ['scan', ...argv];
}

const rawArgs = withDefaultCommand(process.argv.slice(2));
const command = rawArgs[0];
if (command !== undefined && Object.hasOwn(subCommands, command)) {
  const { unknown, missingValue } = flagProblems(
    rawArgs.slice(1),
    subCommands[command as keyof typeof subCommands].args as ArgsDef,
  );
  if (unknown.length > 0 || missingValue.length > 0) {
    const lines = [
      ...(unknown.length > 0 ? [`unknown option ${unknown.join(', ')}`] : []),
      ...missingValue.map(
        (flag) => `${flag} needs a value; one starting with "-" must be written ${flag}=<value>`,
      ),
    ];
    process.stderr.write(
      `${lines.map((l) => `egressa: ${l}`).join('\n')}\nRun \`egressa ${command} --help\` for the options.\n`,
    );
    process.exit(EXIT.USAGE);
  }
}

// citty's runMain catches every error a command throws and exits 1, which is
// this tool's "findings" code: an internal error would read as findings in CI.
// It is kept for --help and --version only; commands run through runCommand,
// so an error reaches this handler and exits as what it is.
const metaOnly =
  rawArgs.includes('--help') ||
  rawArgs.includes('-h') ||
  (rawArgs.length === 1 && rawArgs[0] === '--version');
const run = metaOnly ? runMain(main, { rawArgs }) : runCommand(main, { rawArgs });
run.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`egressa: ${message}\n`);
  // citty's own argument errors (an unknown subcommand, a missing positional).
  const usage = error instanceof Error && error.name === 'CLIError';
  process.exit(usage ? EXIT.USAGE : EXIT.INTERNAL);
});
