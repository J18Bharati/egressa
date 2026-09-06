#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { explainCommand } from './commands/explain.js';
import { scanCommand } from './commands/scan.js';
import { schemaCommand } from './commands/schema.js';
import { vendorsCommand } from './commands/vendors.js';
import { EXIT } from './exit-codes.js';

const main = defineCommand({
  meta: {
    name: 'adequacy',
    description:
      'Detects third-party data-egress patterns in source code and their cross-border ' +
      'transfer exposure. Does not assess or certify GDPR compliance.',
  },
  subCommands: {
    scan: scanCommand,
    vendors: vendorsCommand,
    explain: explainCommand,
    schema: schemaCommand,
  },
  // `adequacy .` with no subcommand runs a scan, which is what people type.
  args: scanCommand.args,
  async run(context) {
    if (
      context.rawArgs.length === 0 ||
      context.rawArgs[0]?.startsWith('-') ||
      existsAsPath(context.rawArgs[0])
    ) {
      return scanCommand.run?.(context as never);
    }
    return undefined;
  },
});

function existsAsPath(value: string | undefined): boolean {
  return value !== undefined && !value.startsWith('-');
}

runMain(main).catch((error: unknown) => {
  process.stderr.write(`adequacy: ${(error as Error).message}\n`);
  process.exit(EXIT.INTERNAL);
});
