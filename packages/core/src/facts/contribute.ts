import {
  type KnowledgeBase,
  type VendorEntry,
  bundledSchemaIssues,
  collisionIssues,
  entryIssues,
} from '@egressa/kb';
import { findForbiddenClaims } from '../claims.js';
import { type FactsCheck, type RepositoryFact, safeIssue } from './load.js';
import { withFact } from './overlay.js';

/**
 * `egressa facts contribute <vendorId>`: turns what a repository's facts file
 * says about one vendor into a draft for the shared knowledge base.
 *
 * Offline and inert by construction. This module imports no network, process
 * or filesystem module (a test reads its imports), takes an already-checked
 * facts file and the knowledge base, and returns text. It never reads the
 * scanned code, so nothing from it -- paths, snippets, other vendors -- can
 * reach a draft; only the one vendor's entry or facts can. Sending the draft
 * anywhere is the user's decision and the user's action.
 *
 * What it leaves out on purpose:
 * - `acceptQualifiedStatus`: a team's own risk decision, not a fact about the
 *   vendor, so the record is drafted as the closed status table reads it;
 * - `verifiedBy` names, unless the caller asks to keep them;
 * - expired and rejected items, and every other vendor in the file.
 */

export type ContributionKind = 'new-entry' | 'field-patch';

export interface FieldChange {
  /** Dotted path in the entry, such as `legal.dpa`. */
  path: string;
  from: unknown;
  to: unknown;
  source: { url: string; retrievedAt: string };
}

export interface ContributionBundle {
  kind: ContributionKind;
  vendorId: string;
  /** The complete `kb/vendors/<id>.json` the contribution proposes. */
  draft: VendorEntry;
  /** For a field patch, each change with its source. Empty for a new entry. */
  changes: FieldChange[];
  /** Problems `pnpm kb:validate` would report; a bundle with any is not ready. */
  issues: string[];
  checklist: string[];
  evidenceUrls: string[];
  /** A pull request or issue body, markdown, with the draft in it. */
  body: string;
}

export class ContributionError extends Error {}

export interface ContributeOptions {
  /** Keep the `verifiedBy` of each fact in the body, crediting whoever checked it. */
  keepVerifiedBy?: boolean;
}

/** What the entry says about who drafted it, until a maintainer re-verifies it. */
const DRAFTED_BY = 'contributor draft from repository facts; maintainer to re-verify';

export function contribution(
  vendorId: string,
  checked: FactsCheck,
  kb: KnowledgeBase,
  options: ContributeOptions = {},
): ContributionBundle {
  const current = checked.items.filter((i) => i.state === 'current');
  const local = current.find((i) => i.kind === 'local-entry' && i.local?.entry.id === vendorId);
  const facts = current.flatMap((i) =>
    i.fact && i.fact.vendor === vendorId ? [withoutLocalDecision(i.fact)] : [],
  );
  const shipped = kb.byId.get(vendorId);

  if (!local && !shipped) {
    throw new ContributionError(
      `${checked.source} has no current local entry for this vendor, and the knowledge base has no entry to patch`,
    );
  }
  if (!local && facts.length === 0) {
    throw new ContributionError(
      `${checked.source} has no current fact about this vendor; an expired or rejected one is not contributed`,
    );
  }

  const kind: ContributionKind = local ? 'new-entry' : 'field-patch';
  const base: VendorEntry = local?.local
    ? { ...local.local.entry, verifiedBy: DRAFTED_BY }
    : (shipped as VendorEntry);
  const changes: FieldChange[] = [];
  let draft = base;
  for (const fact of facts) {
    const next = withFact(draft, fact);
    const path = PATHS[fact.fact];
    changes.push({
      path,
      from: pick(draft, path),
      to: pick(next, path),
      source: { url: fact.source.url, retrievedAt: fact.source.retrievedAt },
    });
    draft = withSource(next, fact);
  }
  if (kind === 'field-patch') draft = { ...draft, verifiedBy: DRAFTED_BY };

  const issues = validate(draft, kb, kind);
  const evidenceUrls = [...new Set(draft.sources.map((s) => s.url))];
  const checklist = CHECKLIST(kind);
  const credits = options.keepVerifiedBy
    ? [
        ...new Set(
          facts.map((f) => f.verifiedBy).concat(local?.local ? [local.local.verifiedBy] : []),
        ),
      ]
    : [];
  return {
    kind,
    vendorId,
    draft,
    changes: kind === 'field-patch' ? changes : [],
    issues,
    checklist,
    evidenceUrls,
    body: renderBody({ kind, vendorId, draft, changes, issues, checklist, evidenceUrls, credits }),
  };
}

const PATHS: Record<RepositoryFact['fact'], string> = {
  dpf: 'legal.transferMechanisms',
  dpa: 'legal.dpa',
  subprocessors: 'legal.subprocessors',
};

function pick(entry: VendorEntry, path: string): unknown {
  return path.split('.').reduce<unknown>((v, key) => (v as Record<string, unknown>)?.[key], entry);
}

/** A qualified DPF status is drafted as the table reads it; acceptance is local. */
function withoutLocalDecision(fact: RepositoryFact): RepositoryFact {
  if (fact.fact !== 'dpf' || !fact.acceptQualifiedStatus) return fact;
  const { acceptQualifiedStatus: _accepted, ...rest } = fact;
  return rest;
}

/** The fact's page joins the entry's sources, so the citation travels with the change. */
function withSource(entry: VendorEntry, fact: RepositoryFact): VendorEntry {
  if (entry.sources.some((s) => s.url === fact.source.url)) return entry;
  const title =
    fact.fact === 'dpf'
      ? `Data Privacy Framework participant record (status read as "${fact.value.observedStatus}")`
      : fact.fact === 'dpa'
        ? 'Data processing agreement'
        : 'Sub-processor list';
  return {
    ...entry,
    sources: [
      ...entry.sources,
      {
        url: fact.source.url,
        title,
        publisher: fact.fact === 'dpf' ? 'regulator' : 'vendor',
        accessedAt: fact.source.retrievedAt,
      },
    ],
  };
}

/**
 * The checks `pnpm kb:validate` runs that one entry can fail: the bundled
 * schema, the per-entry checks, collisions it would introduce, and forbidden
 * claim words anywhere in it. Messages are the redacted forms, since the entry
 * came from a repository.
 */
function validate(draft: VendorEntry, kb: KnowledgeBase, kind: ContributionKind): string[] {
  const others = kb.vendors.filter((v) => v.id !== draft.id);
  const before = new Set(collisionIssues(others).map((i) => i.message));
  const collisions = collisionIssues([...others, draft]).filter((i) => !before.has(i.message));
  const forbidden = findForbiddenClaims(JSON.stringify(draft));
  return [
    ...bundledSchemaIssues('vendor-1.0.0.json', null, draft).map((m) => `schema: ${m}`),
    ...entryIssues(draft).map((i) => i.redacted),
    ...collisions.map((i) => i.redacted),
    ...(forbidden.length > 0 ? ['contains a forbidden claim word'] : []),
    ...(kind === 'new-entry' && kb.byId.has(draft.id)
      ? ['the knowledge base already has this id; contribute a field patch instead']
      : []),
  ].map(safeIssue);
}

const CHECKLIST = (kind: ContributionKind): string[] => [
  'I opened every evidence URL below myself and each one says what the draft says, as of its date.',
  'Any DPF status is copied verbatim from the participant record, and dpfCertified follows the status table.',
  'Every fact is clean-room authored from vendor or regulator pages, and nothing comes from a source kb/PROVENANCE.md forbids.',
  'The draft names no person and contains nothing from my own codebase.',
  'I license this contribution under CC-BY-4.0, like the rest of kb/.',
  ...(kind === 'new-entry'
    ? ['Hosts and packages are ones the vendor documents, not ones seen only in my code.']
    : []),
];

function renderBody(b: {
  kind: ContributionKind;
  vendorId: string;
  draft: VendorEntry;
  changes: FieldChange[];
  issues: string[];
  checklist: string[];
  evidenceUrls: string[];
  credits: string[];
}): string {
  const json = JSON.stringify(b.draft, null, 2);
  const fence = '`'.repeat(Math.max(3, longestRun(json, '`') + 1));
  const lines = [
    `## Knowledge base ${b.kind === 'new-entry' ? 'entry' : 'update'}: ${b.vendorId}`,
    '',
    'Drafted offline by `egressa facts contribute` from a repository facts file. It contains ' +
      "this one vendor's entry and the pages it cites, and nothing else from the repository. " +
      'Publishing it does say that a codebase you work on uses this vendor.',
    '',
  ];
  if (b.issues.length > 0) {
    lines.push('### Not ready: `pnpm kb:validate` would refuse it', '');
    for (const issue of b.issues) lines.push(`- ${issue}`);
    lines.push('');
  }
  if (b.changes.length > 0) {
    lines.push('### Changes', '');
    for (const c of b.changes) {
      lines.push(`- \`${c.path}\`, read ${c.source.retrievedAt} at ${c.source.url}`);
    }
    lines.push('');
  }
  lines.push('### Checklist', '');
  for (const item of b.checklist) lines.push(`- [ ] ${item}`);
  lines.push('', '### Evidence', '');
  for (const url of b.evidenceUrls) lines.push(`- ${url}`);
  if (b.credits.length > 0) {
    lines.push('', `Checked by: ${b.credits.join('; ')}`);
  }
  lines.push(
    '',
    'A maintainer re-fetches every source before merging and sets `lastVerified` to that date.',
    '',
    `### Draft \`kb/vendors/${b.vendorId}.json\``,
    '',
    `${fence}json`,
    json,
    fence,
    '',
  );
  return lines.join('\n');
}

function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}
