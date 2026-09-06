import { loadKnowledgeBase } from '@adequacy/kb';
import { defineCommand } from 'citty';

/**
 * Makes the knowledge base usable without running a scan. This is what turns
 * the data into something people consult directly rather than an implementation
 * detail of the scanner.
 */
export const vendorsCommand = defineCommand({
  meta: { name: 'vendors', description: 'Inspect the vendor knowledge base' },
  args: {
    action: {
      type: 'positional',
      required: false,
      default: 'list',
      description: 'list | show | search',
    },
    query: { type: 'positional', required: false, description: 'Vendor id, package name or host' },
    kb: { type: 'string', description: 'Path to a knowledge base directory' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const kb = loadKnowledgeBase(args.kb ? { kbPath: String(args.kb) } : {});
    const action = String(args.action);
    const query = args.query ? String(args.query) : undefined;

    if (action === 'list') {
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify(
            kb.vendors.map((v) => ({
              id: v.id,
              name: v.name,
              category: v.category,
              jurisdictions: v.processing.jurisdictions.map((j) => j.country),
            })),
            null,
            2,
          )}\n`,
        );
        return;
      }
      for (const vendor of kb.vendors) {
        const countries = vendor.processing.jurisdictions.map((j) => j.country).join(', ');
        process.stdout.write(
          `${vendor.id.padEnd(20)} ${vendor.category.padEnd(16)} ${countries}\n`,
        );
      }
      return;
    }

    if (!query) {
      process.stderr.write(`adequacy: "vendors ${action}" needs an argument\n`);
      process.exit(2);
    }

    const entry =
      kb.byId.get(query) ??
      kb.lookupPackage('npm', query)?.vendor ??
      kb.lookupHost(query)?.vendor ??
      null;

    if (!entry) {
      process.stdout.write(`No knowledge base entry matches "${query}".\n`);
      process.exit(0);
    }

    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  },
});
