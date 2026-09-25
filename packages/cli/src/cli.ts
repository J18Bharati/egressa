import { type ArgsDef, defineCommand, runMain } from 'citty';
import { explainCommand } from './commands/explain.js';
import { scanCommand } from './commands/scan.js';
import { schemaCommand } from './commands/schema.js';
import { vendorsCommand } from './commands/vendors.js';
import { EXIT } from './exit-codes.js';
import { unknownFlags } from './flags.js';
import { TOOL_VERSION } from './version.js';

const subCommands = {
  scan: scanCommand,
  vendors: vendorsCommand,
  explain: explainCommand,
  schema: schemaCommand,
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
  const unknown = unknownFlags(
    rawArgs.slice(1),
    subCommands[command as keyof typeof subCommands].args as ArgsDef,
  );
  if (unknown.length > 0) {
    process.stderr.write(
      `egressa: unknown option ${unknown.join(', ')}. Run \`egressa ${command} --help\` for the options.\n`,
    );
    process.exit(EXIT.USAGE);
  }
}

runMain(main, { rawArgs }).catch((error: unknown) => {
  process.stderr.write(`egressa: ${(error as Error).message}\n`);
  process.exit(EXIT.INTERNAL);
});
