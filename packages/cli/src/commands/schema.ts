import { defineCommand } from 'citty';
import facts from '../../../../kb/schema/facts-1.0.0.json' with { type: 'json' };
import vendor from '../../../../kb/schema/vendor-1.0.0.json' with { type: 'json' };
import findings from '../../../../schemas/findings-1.1.0.json' with { type: 'json' };

/**
 * The published schemas, inlined at build time. Reading them from disk at run
 * time resolved against the working directory, so outside a checkout of this
 * repository the command failed, and inside someone else's it printed whatever
 * file sat at that path. `cli.test.ts` holds each one to its source file, and
 * the findings one to `FINDINGS_SCHEMA_VERSION`.
 */
export const SCHEMAS = { findings, vendor, facts } as const;

/** Prints the published schemas, so a consumer can pin against them offline. */
export const schemaCommand = defineCommand({
  meta: { name: 'schema', description: 'Print a published JSON schema' },
  args: {
    which: {
      type: 'positional',
      required: false,
      default: 'findings',
      description: 'findings | vendor | facts',
    },
  },
  run({ args }) {
    const which = String(args.which);
    if (!Object.hasOwn(SCHEMAS, which)) {
      process.stderr.write(
        `egressa: unknown schema (expected one of ${Object.keys(SCHEMAS).join(', ')})\n`,
      );
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(SCHEMAS[which as keyof typeof SCHEMAS], null, 2)}\n`);
  },
});
