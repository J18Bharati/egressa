import { readFileSync } from 'node:fs';
import { defineCommand } from 'citty';

/** Prints the published schemas, so a consumer can pin against them offline. */
export const schemaCommand = defineCommand({
  meta: { name: 'schema', description: 'Print a published JSON schema' },
  args: {
    which: {
      type: 'positional',
      required: false,
      default: 'findings',
      description: 'findings | vendor',
    },
  },
  run({ args }) {
    const which = String(args.which);
    const path = which === 'vendor' ? 'kb/schema/vendor-1.0.0.json' : 'schemas/findings-1.0.0.json';
    try {
      process.stdout.write(readFileSync(path, 'utf8'));
    } catch {
      process.stderr.write(`egressa: schema "${which}" not found\n`);
      process.exit(2);
    }
  },
});
