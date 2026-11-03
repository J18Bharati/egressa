import { loadKnowledgeBase } from '@egressa/kb';
import { loosenedByFacts } from '../output/provenance.js';
import { type ScanOptions, scan } from '../scan.js';
import type { FactsSummary, RuleId, ScanResult, VerifyTask } from '../types.js';
import { FACTS_FILE, FactsError, MAX_FACTS_BYTES, checkFacts, parseFacts } from './load.js';
import { type OverlayItem, applyOverlay } from './overlay.js';

/**
 * An item as surfaces print it: its state and provenance, never a local
 * entry's body. A local entry is a whole vendor record, and a reader needs its
 * verdict, not a copy of it.
 */
export type PublicOverlayItem = Omit<OverlayItem, 'local'>;

export function publicOverlayItem(item: OverlayItem): PublicOverlayItem {
  const { local: _local, ...rest } = item;
  return rest;
}

/**
 * Every verification task a scan produced, once each, in finding order. Tasks
 * hang off findings (a stale entry's note, a vendor finding in doubt, an
 * expired repository fact, an unknown vendor), so this is the one list an
 * agent works from.
 */
export function verificationTasks(result: ScanResult): VerifyTask[] {
  const seen = new Set<string>();
  const tasks: VerifyTask[] = [];
  for (const finding of result.findings) {
    for (const task of finding.verification ?? []) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
    }
  }
  return tasks;
}

export interface FactsPreview {
  /** What each item in the draft would be: applied, rejected, and so on. */
  items: PublicOverlayItem[];
  /** The scan's facts counts with the draft in place of the repository's file. */
  facts: FactsSummary | null;
  /** Findings whose rule the draft changes, and whether it loosens them. */
  changes: {
    findingId: string;
    vendorId: string | null;
    from: RuleId;
    to: RuleId;
    loosened: boolean;
  }[];
}

/**
 * What a draft `.egressa/facts.json` would do to a scan of `root`, as if it
 * replaced the repository's file. Writes nothing: the draft is text in memory,
 * and the scan reads the repository as it is. Throws `FactsError` for a draft
 * that is not a facts document, exactly as `loadFacts` would for the file.
 */
export function previewFacts(draft: string, options: Omit<ScanOptions, 'facts'>): FactsPreview {
  const label = `${FACTS_FILE} (draft)`;
  // The file's own cap, in bytes. A draft the preview accepts must be one the
  // scan would read: a cap in characters let a non-ASCII draft through here.
  if (Buffer.byteLength(draft, 'utf8') > MAX_FACTS_BYTES) {
    throw new FactsError(`${label}: is larger than ${MAX_FACTS_BYTES / 1_048_576} MB; not read`);
  }
  const parsed = parseFacts(draft, label);
  const now = options.now ?? new Date();
  // Loaded as `scan` loads it, so an assumed lapse is in the baseline the
  // overlay is measured against, not only in the scan that follows.
  const kb =
    options.kb ??
    loadKnowledgeBase({
      ...(options.kbPath ? { kbPath: options.kbPath } : {}),
      ...(options.assumeAdequacyLapsed
        ? { assumeAdequacyLapsed: options.assumeAdequacyLapsed }
        : {}),
    });
  const overlay = applyOverlay(kb, checkFacts(parsed, kb, now), {
    trustFacts: options.trustFacts === true,
  });
  const result = scan({ ...options, kb, now, facts: parsed });
  return {
    items: overlay.items.map(publicOverlayItem),
    facts: result.facts ?? null,
    changes: result.findings.flatMap((f) =>
      f.baselineRuleId
        ? [
            {
              findingId: f.id,
              vendorId: f.vendor?.id ?? null,
              from: f.baselineRuleId,
              to: f.ruleId,
              loosened: loosenedByFacts(f),
            },
          ]
        : [],
    ),
  };
}
