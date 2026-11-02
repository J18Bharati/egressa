import { FactsError, type OverlayItem, applyOverlay, checkFacts, loadFacts } from '@egressa/core';
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
 */
export const factsCommand = defineCommand({
  meta: { name: 'facts', description: "Check a repository's .egressa/facts.json" },
  args: {
    action: { type: 'positional', required: false, default: 'check', description: 'check' },
    root: { type: 'positional', required: false, default: '.', description: 'Repository root' },
    kb: { type: 'string', description: 'Path to a knowledge base directory' },
    json: { type: 'boolean', default: false },
    'trust-facts': {
      type: 'boolean',
      default: false,
      description: 'Show the states a scan with --trust-facts would apply',
    },
  },
  async run({ args }) {
    const action = String(args.action);
    if (action !== 'check') {
      process.stderr.write(`egressa: unknown facts action "${action}"; use check\n`);
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
    let checked: { source: string; items: OverlayItem[] } | null;
    try {
      const parsed = loadFacts(String(args.root));
      checked = parsed
        ? applyOverlay(kb, checkFacts(parsed, kb, new Date()), {
            trustFacts: args['trust-facts'] === true,
          })
        : null;
    } catch (error) {
      if (!(error instanceof FactsError)) throw error;
      process.stderr.write(`egressa: ${error.message}\n`);
      process.exit(EXIT.USAGE);
    }
    const text = args.json
      ? `${JSON.stringify(checked ? { source: checked.source, items: checked.items.map(publicItem) } : { source: null, items: [] }, null, 2)}\n`
      : formatCheck(checked);
    const rejected = checked?.items.some((i) => i.state === 'rejected') ?? false;
    await writeOutAndExit(text, rejected ? EXIT.FINDINGS : EXIT.CLEAN);
  },
});

/** What `--json` prints for an item: its state and provenance, not the whole local entry. */
function publicItem(item: OverlayItem) {
  const { local: _local, ...rest } = item;
  return rest;
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
