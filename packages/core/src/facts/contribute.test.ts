import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledSchemaIssues, loadKnowledgeBase } from '@egressa/kb';
import { describe, expect, it } from 'vitest';
import { ContributionError, contribution } from './contribute.js';
import { type FactsCheck, checkFacts, loadFacts } from './load.js';

const ROOT = 'fixtures/repos/overlay-dpf';
const NOW = new Date('2026-11-10T12:00:00Z');
const kb = loadKnowledgeBase({ kbPath: 'kb' });
const SENTINEL = 'EGRESSA_SENTINEL_7f3a91';

/** The overlay fixture, copied, with a sentinel planted everywhere but the facts file. */
function plantedRepo(edit?: (facts: { facts: Record<string, unknown>[] }) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'egressa-contribute-'));
  cpSync(ROOT, dir, { recursive: true });
  writeFileSync(join(dir, 'src', 'secret.js'), `export const k = '${SENTINEL}';\n`);
  writeFileSync(
    join(dir, 'src', 'geo.js'),
    `${readFileSync(join(dir, 'src', 'geo.js'), 'utf8')}// ${SENTINEL}\n`,
  );
  if (edit) {
    const path = join(dir, '.egressa', 'facts.json');
    const facts = JSON.parse(readFileSync(path, 'utf8'));
    edit(facts);
    writeFileSync(path, JSON.stringify(facts));
  }
  return dir;
}

function checked(root: string, now = NOW): FactsCheck {
  const parsed = loadFacts(root);
  if (!parsed) throw new Error('no facts file');
  return checkFacts(parsed, kb, now);
}

describe('facts contribute', () => {
  it('drafts a new entry from a local vendor that passes the bundled schema', () => {
    const bundle = contribution('acme-geo', checked(ROOT), kb);
    expect(bundle.kind).toBe('new-entry');
    expect(bundle.issues).toEqual([]);
    expect(bundledSchemaIssues('vendor-1.0.0.json', null, bundle.draft)).toEqual([]);
    expect(bundle.draft.verifiedBy).toMatch(/maintainer to re-verify/);
    expect(bundle.body).toContain('CC-BY-4.0');
    expect(bundle.body).toContain('### Draft `kb/vendors/acme-geo.json`');
  });

  it('carries nothing from the scanned code or about other vendors', () => {
    const root = plantedRepo();
    for (const id of ['acme-geo', 'stripe', 'notion']) {
      const text = JSON.stringify(contribution(id, checked(root), kb));
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain('src/');
      expect(text).not.toContain('.egressa/facts.json');
      expect(text).not.toContain('facts[');
    }
    // Stripe's bundle names no other vendor's fact or entry.
    const stripe = JSON.stringify(contribution('stripe', checked(root), kb));
    expect(stripe).not.toContain('participant/6134');
    expect(stripe).not.toContain('acme-geo');
  });

  it('drafts a field patch as a scan applies the fact, citing its source', () => {
    const bundle = contribution('stripe', checked(ROOT), kb);
    expect(bundle.kind).toBe('field-patch');
    expect(bundle.changes).toHaveLength(1);
    expect(bundle.changes[0]?.path).toBe('legal.transferMechanisms');
    const dpf = bundle.draft.legal.transferMechanisms.find((m) => m.mechanism === 'DPF');
    expect(dpf).toMatchObject({ observedStatus: 'Inactive - Lapse', dpfCertified: false });
    expect(bundle.draft.sources.map((s) => s.url)).toContain(
      'https://www.dataprivacyframework.gov/participant/10014',
    );
    expect(bundle.issues).toEqual([]);
  });

  it('leaves out a local acceptance of a qualified status, and verifiedBy names', () => {
    const root = plantedRepo((file) => {
      file.facts[0] = {
        ...file.facts[0],
        value: {
          observedStatus: 'Active - Re-certification under Review',
          organizationName: 'Notion Labs, Inc.',
          participantUrl: 'https://www.dataprivacyframework.gov/participant/6134',
        },
        source: {
          url: 'https://www.dataprivacyframework.gov/participant/6134',
          retrievedAt: '2026-11-09',
        },
        verifiedBy: 'Pat Example',
        acceptQualifiedStatus: { acceptedBy: 'Pat Example', reason: 'reviewed the record' },
      };
    });
    const bundle = contribution('notion', checked(root), kb);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('acceptQualifiedStatus');
    expect(text).not.toContain('Pat Example');
    const dpf = bundle.draft.legal.transferMechanisms.find((m) => m.mechanism === 'DPF');
    expect(dpf?.dpfCertified).toBe(false);
    // Kept only when the caller asks to credit whoever checked it.
    expect(contribution('notion', checked(root), kb, { keepVerifiedBy: true }).body).toContain(
      'Checked by: `Pat Example`',
    );
  });

  it('reports what kb:validate would refuse, without quoting the entry', () => {
    const check = checked(ROOT);
    const item = check.items.find((i) => i.kind === 'local-entry');
    if (!item?.local) throw new Error('no local entry');
    item.local = {
      ...item.local,
      entry: { ...item.local.entry, notes: 'A risky vendor <img src=x>.' },
    };
    const bundle = contribution('acme-geo', check, kb);
    expect(bundle.issues.some((i) => /evaluative language/.test(i))).toBe(true);
    expect(bundle.issues.join('\n')).not.toContain('<img');
  });

  it('refuses a vendor with nothing current to contribute', () => {
    expect(() => contribution('nobody', checked(ROOT), kb)).toThrow(ContributionError);
    // Past every fact's expiry, nothing is current.
    const later = checked(ROOT, new Date('2027-06-01T00:00:00Z'));
    expect(() => contribution('stripe', later, kb)).toThrow(/no current fact/);
    expect(() => contribution('acme-geo', later, kb)).toThrow(ContributionError);
  });

  it('imports no network, process or filesystem module', () => {
    const source = readFileSync('packages/core/src/facts/contribute.ts', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      '../claims.js',
      '../output/display.js',
      './load.js',
      './overlay.js',
      '@egressa/kb',
    ]);
    expect(source).not.toMatch(/\bprocess\.|\bfetch\(|\brequire\(|\bimport\(/);
  });

  it('drops a local entry’s own DPF acceptance and recomputes its certification', () => {
    const check = checked(ROOT);
    const item = check.items.find((i) => i.kind === 'local-entry');
    if (!item?.local) throw new Error('no local entry');
    const entry = item.local.entry;
    item.local = {
      ...item.local,
      entry: {
        ...entry,
        legal: {
          ...entry.legal,
          transferMechanisms: [
            ...entry.legal.transferMechanisms,
            {
              mechanism: 'DPF',
              dpfCertified: true,
              observedStatus: 'Active - Re-certification under Review',
              url: 'https://www.dataprivacyframework.gov/participant/1',
              lastChecked: '2026-11-02',
              acceptQualifiedStatus: { acceptedBy: 'Jane Doe, Head of Legal', reason: 'TICKET-9' },
            },
          ],
        },
      },
    };
    const bundle = contribution('acme-geo', check, kb);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('Jane Doe');
    expect(text).not.toContain('TICKET-9');
    const dpf = bundle.draft.legal.transferMechanisms.find((m) => m.mechanism === 'DPF');
    expect(dpf?.dpfCertified).toBe(false);
  });

  it('shows a Changes section only for a field patch', () => {
    expect(contribution('acme-geo', checked(ROOT), kb).body).not.toContain('### Changes');
    expect(contribution('stripe', checked(ROOT), kb).body).toContain('### Changes');
  });

  it('records what a field patch changes, from and to, and cites each source once', () => {
    const bundle = contribution('stripe', checked(ROOT), kb);
    const change = bundle.changes[0];
    expect(change?.from).not.toEqual(change?.to);
    const urls = bundle.draft.sources.map((s) => s.url);
    expect(urls.length).toBe(new Set(urls).size);
  });

  it('reports a collision with a shipped vendor as an issue', () => {
    const check = checked(ROOT);
    const item = check.items.find((i) => i.kind === 'local-entry');
    if (!item?.local) throw new Error('no local entry');
    const entry = item.local.entry;
    item.local = {
      ...item.local,
      entry: {
        ...entry,
        aliases: {
          ...entry.aliases,
          hosts: [{ pattern: 'api.stripe.com', match: 'exact', purpose: 'api' }],
        },
      },
    };
    expect(contribution('acme-geo', check, kb).issues.join('\n')).toMatch(
      /collid|claimed|already/i,
    );
  });

  it('renders credited names as code spans, so they cannot mention or link', () => {
    const root = plantedRepo((file) => {
      file.facts[1] = { ...file.facts[1], verifiedBy: '@org/legal see www.evil.example' };
    });
    const body = contribution('stripe', checked(root), kb, { keepVerifiedBy: true }).body;
    expect(body).toContain('Checked by: `@org/legal see www.evil.example`');
  });
});
