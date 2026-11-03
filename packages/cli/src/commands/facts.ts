import { statSync } from 'node:fs';
import {
  ContributionError,
  FactsError,
  type OverlayItem,
  applyOverlay,
  checkFacts,
  contribution,
  loadFacts,
  publicOverlayItem,
} from '@egressa/core';
import { KnowledgeBaseError, loadKnowledgeBase } from '@egressa/kb';
import { defineCommand } from 'citty';
import { writeOutAndExit } from '../emit.js';
import { EXIT } from '../exit-codes.js';

/**
 * `egressa facts check [root]`: what this repository's `.egressa/facts.json`
 * holds, and what each item's state is. Reads no network and changes nothing.
 *
 * Exits 0 when every item is usable or merely expired, 1 when any is
 * rejected, and 2 when the file cannot be read as a facts document at all.
 *
 * `egressa facts contribute <vendorId> [--root dir]`: a draft for the shared
 * knowledge base from one vendor's local entry or facts, printed and never
 * sent. Exits 2 when there is nothing to contribute or the draft would fail
 * `pnpm kb:validate`.
 */
export const factsCommand = defineCommand({
  meta: { name: 'facts', description: "Check a repository's .egressa/facts.json" },
  args: {
    action: {
      type: 'positional',
      required: false,
      default: 'check',
      description: 'check | contribute',
    },
    target: {
      type: 'positional',
      required: false,
      description: 'check: the repository root (default .); contribute: the vendor id',
    },
    root: { type: 'string', description: 'contribute: the repository root (default .)' },
    kb: { type: 'string', description: 'Path to a knowledge base directory' },
    json: { type: 'boolean', default: false },
    'trust-facts': {
      type: 'boolean',
      default: false,
      description: 'Show the states a scan with --trust-facts would apply',
    },
    'keep-verified-by': {
      type: 'boolean',
      default: false,
      description: 'contribute: credit whoever checked each fact in the draft body',
    },
  },
  async run({ args }) {
    const action = String(args.action);
    if (action !== 'check' && action !== 'contribute') {
      process.stderr.write('egressa: unknown facts action; use check or contribute\n');
      process.exit(EXIT.USAGE);
    }
    if (action === 'contribute' && !args.target) {
      process.stderr.write('egressa: facts contribute needs a vendor id\n');
      process.exit(EXIT.USAGE);
    }
    let kb: ReturnType<typeof loadKnowledgeBase>;
    try {
      kb = loadKnowledgeBase(args.kb ? { kbPath: String(args.kb) } : {});
    } catch (error) {
      if (!(error instanceof KnowledgeBaseError)) throw error;
      process.stderr.write(`egressa: could not load the knowledge base: ${error.message}\n`);
      process.exit(EXIT.KB);
    }
    // A mistyped path would otherwise read as "no facts file", exit 0.
    const root = String((action === 'contribute' ? args.root : args.target) ?? '.');
    if (!isDirectory(root)) {
      process.stderr.write(`egressa: ${root} is not a directory\n`);
      process.exit(EXIT.USAGE);
    }
    if (action === 'contribute') {
      await contribute(String(args.target), root, kb, {
        json: args.json === true,
        keepVerifiedBy: args['keep-verified-by'] === true,
      });
      return;
    }
    let checked: { source: string; items: OverlayItem[] } | null;
    try {
      const parsed = loadFacts(root);
      checked = parsed
        ? applyOverlay(kb, checkFacts(parsed, kb, new Date()), {
            trustFacts: args['trust-facts'] === true,
          })
        : null;
    } catch (error) {
      if (error instanceof KnowledgeBaseError) {
        process.stderr.write(`egressa: could not load the knowledge base: ${error.message}\n`);
        process.exit(EXIT.KB);
      }
      if (!(error instanceof FactsError)) throw error;
      process.stderr.write(`egressa: ${error.message}\n`);
      process.exit(EXIT.USAGE);
    }
    const text = args.json
      ? `${JSON.stringify(checked ? { source: checked.source, items: checked.items.map(publicOverlayItem) } : { source: null, items: [] }, null, 2)}\n`
      : formatCheck(checked);
    const rejected = checked?.items.some((i) => i.state === 'rejected') ?? false;
    await writeOutAndExit(text, rejected ? EXIT.FINDINGS : EXIT.CLEAN);
  },
});

async function contribute(
  vendorId: string,
  root: string,
  kb: ReturnType<typeof loadKnowledgeBase>,
  options: { json: boolean; keepVerifiedBy: boolean },
): Promise<void> {
  let parsed: ReturnType<typeof loadFacts>;
  try {
    parsed = loadFacts(root);
  } catch (error) {
    if (!(error instanceof FactsError)) throw error;
    process.stderr.write(`egressa: ${error.message}\n`);
    process.exit(EXIT.USAGE);
  }
  if (!parsed) {
    process.stderr.write('egressa: no .egressa/facts.json in this repository\n');
    process.exit(EXIT.USAGE);
  }
  try {
    const bundle = contribution(vendorId, checkFacts(parsed, kb, new Date()), kb, {
      keepVerifiedBy: options.keepVerifiedBy,
    });
    // A draft `pnpm kb:validate` would refuse is not printed as one.
    if (bundle.issues.length > 0) {
      process.stderr.write(
        `egressa: the draft would not pass pnpm kb:validate:\n${bundle.issues.map((i) => `  - ${i}`).join('\n')}\n`,
      );
      process.exit(EXIT.USAGE);
    }
    const text = options.json ? `${JSON.stringify(bundle, null, 2)}\n` : bundle.body;
    await writeOutAndExit(text, EXIT.CLEAN);
  } catch (error) {
    if (!(error instanceof ContributionError)) throw error;
    process.stderr.write(`egressa: ${error.message}\n`);
    process.exit(EXIT.USAGE);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const STATES = [
  'applied',
  'redundant',
  'loosening-not-trusted',
  'superseded',
  'expired',
  'rejected',
] as const;

export function formatCheck(checked: { source: string; items: OverlayItem[] } | null): string {
  if (!checked) return 'No .egressa/facts.json in this repository.\n';
  if (checked.items.length === 0) return `${checked.source}: no facts.\n`;
  const lines = checked.items.map((item) => {
    const detail =
      item.state === 'rejected' || item.state === 'superseded'
        ? (item.reason ?? '')
        : item.state === 'expired'
          ? `expired ${item.expiresOn}; the knowledge base's own fact applies`
          : item.state === 'redundant'
            ? 'says what the knowledge base says; can be deleted'
            : item.state === 'loosening-not-trusted'
              ? 'would loosen a finding; applied only with --trust-facts'
              : `${item.effect ?? 'neutral'}, until ${item.expiresOn}`;
    return `  ${item.at.padEnd(16)} ${(item.vendor ?? '-').padEnd(20)} ${(item.kind ?? '').padEnd(14)} ${item.state.padEnd(22)} ${detail}`;
  });
  const counts = STATES.map((state) => {
    const n = checked.items.filter((i) => i.state === state).length;
    return n > 0 ? `${n} ${state}` : null;
  }).filter((x) => x !== null);
  return `${checked.source}: ${counts.join(', ')}\n${lines.join('\n')}\n`;
}
