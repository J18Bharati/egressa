import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostTrie, loadKnowledgeBase, normaliseHost } from './index.js';
import type { HostAlias, VendorEntry } from './types.js';

const kb = loadKnowledgeBase({ kbPath: 'kb' });

describe('loadKnowledgeBase', () => {
  it('loads every vendor entry deterministically', () => {
    // Sorted by id, and read from the directory rather than a hand-kept list:
    // the property under test is the ordering, not the roster, and pinning the
    // roster here means every new entry is a test failure for no reason.
    const ids = kb.vendors.map((v) => v.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('stripe');
  });

  it('resolves official SDK packages to their vendor', () => {
    expect(kb.lookupPackage('npm', 'stripe')?.vendor.id).toBe('stripe');
    expect(kb.lookupPackage('npm', '@sentry/nextjs')?.vendor.id).toBe('sentry');
    expect(kb.lookupPackage('npm', 'openai')?.vendor.id).toBe('openai');
  });

  it('reports the alias kind, which drives confidence', () => {
    expect(kb.lookupPackage('npm', 'stripe')?.alias.kind).toBe('official-sdk');
    expect(kb.lookupPackage('npm', '@sentry/nextjs')?.alias.kind).toBe('framework-integration');
  });

  it('returns null for unknown packages rather than guessing', () => {
    expect(kb.lookupPackage('npm', 'left-pad')).toBeNull();
  });

  it('matches a package nobody enumerated through its vendor scope', () => {
    // An npm scope is a registry-enforced namespace, so @sentry/* is Sentry by
    // construction. This is the recall the exact list kept losing: a vendor
    // ships a new framework integration and the hand-written enumeration is
    // silently a package behind.
    const match = kb.lookupPackage('npm', '@sentry/some-package-nobody-listed');
    expect(match?.vendor.id).toBe('sentry');
    expect(match?.alias.name).toBe('@sentry/*');
    // Never official-sdk: a scope also carries build plugins and type packages,
    // and official-sdk is what lifts a direct dependency to high confidence.
    expect(match?.alias.kind).toBe('scope');
  });

  it('prefers an exact alias over a wildcard scope, so kind survives', () => {
    // @sentry/nextjs is covered by both the exact entry and @sentry/*. The
    // exact one carries the fact that it is a framework integration rather
    // than an official SDK, which is the difference between medium and high
    // confidence on a direct dependency. First-match-by-insertion-order would
    // hold this by accident; precedence is the property under test.
    const match = kb.lookupPackage('npm', '@sentry/nextjs');
    expect(match?.alias.name).toBe('@sentry/nextjs');
    expect(match?.alias.kind).toBe('framework-integration');
    expect(kb.lookupPackage('npm', '@aws-sdk/client-textract')?.alias.kind).toBe('official-sdk');
  });

  it('refuses to attribute a name that two vendor scopes both claim', () => {
    // The failure this replaces is the one findSinks() already had: returning
    // the first matching scope let whichever vendor sorted first silently
    // shadow the other, and the output names a company. A wrong vendor is
    // worse than no vendor, so the ambiguous name degrades to unmatched.
    //
    // Built from a temporary kb/ rather than asserted against the shipped one,
    // because the validator rejects an overlap in the data -- the runtime
    // branch exists for a caller passing its own kbPath.
    const dir = mkdtempSync(join(tmpdir(), 'egressa-kb-'));
    cpSync('kb', dir, { recursive: true });
    const clash = JSON.parse(readFileSync(join(dir, 'vendors/clerk.json'), 'utf8'));
    clash.aliases.packages.npm = [{ name: '@sentry/*', kind: 'scope', detectTransitive: false }];
    writeFileSync(join(dir, 'vendors/clerk.json'), JSON.stringify(clash));
    const ambiguous = loadKnowledgeBase({ kbPath: dir });

    expect(ambiguous.lookupPackage('npm', '@sentry/not-enumerated')).toBeNull();
    // The exact entries still resolve: precedence is checked before ambiguity.
    expect(ambiguous.lookupPackage('npm', '@sentry/nextjs')?.vendor.id).toBe('sentry');
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves documented hosts', () => {
    expect(kb.lookupHost('api.stripe.com')?.vendor.id).toBe('stripe');
    expect(kb.lookupHost('api.eu.mailgun.net')?.vendor.id).toBe('mailgun');
    expect(kb.lookupHost('www.google-analytics.com')?.vendor.id).toBe('google-analytics');
  });

  it('matches subdomains through suffix patterns', () => {
    expect(kb.lookupHost('o4507.ingest.sentry.io')?.vendor.id).toBe('sentry');
  });

  it('returns null for unknown hosts', () => {
    expect(kb.lookupHost('telemetry.acme.io')).toBeNull();
  });
});

describe('adequacy status', () => {
  it('reports the current status of a decision', () => {
    expect(kb.decisionFor('JP')?.status).toBe('in-force');
    expect(kb.decisionFor('US')?.status).toBe('under-challenge');
  });

  it('has no decision for a country without one', () => {
    expect(kb.decisionFor('CN')).toBeNull();
  });

  it('treats an assumed-lapsed country as withdrawn, re-rating without special cases', () => {
    const lapsed = loadKnowledgeBase({ kbPath: 'kb', assumeAdequacyLapsed: ['US:DPF'] });
    expect(lapsed.decisionFor('US')?.status).toBe('withdrawn');
    expect(lapsed.decisionFor('JP')?.status).toBe('in-force');
  });

  it('accepts a bare country code as well as country:mechanism', () => {
    const lapsed = loadKnowledgeBase({ kbPath: 'kb', assumeAdequacyLapsed: ['us'] });
    expect(lapsed.decisionFor('US')?.status).toBe('withdrawn');
  });
});

describe('staleness', () => {
  it('reports nothing stale today', () => {
    expect(kb.staleEntries(new Date('2026-09-06'))).toEqual([]);
  });

  it('reports every entry once the threshold has passed', () => {
    expect(kb.staleEntries(new Date('2027-09-06')).length).toBe(kb.vendors.length);
  });
});

describe('normaliseHost', () => {
  it('lowercases and strips ports and trailing dots', () => {
    expect(normaliseHost('API.Stripe.com:443')).toBe('api.stripe.com');
    expect(normaliseHost('api.stripe.com.')).toBe('api.stripe.com');
  });

  it('rejects things that are not hosts', () => {
    expect(normaliseHost('localhost')).toBeNull();
    expect(normaliseHost('')).toBeNull();
    expect(normaliseHost('${host}')).toBeNull();
  });
});

describe('HostTrie precedence', () => {
  const vendorA = { id: 'a' } as VendorEntry;
  const vendorB = { id: 'b' } as VendorEntry;
  const alias = (pattern: string, match: 'exact' | 'suffix'): HostAlias => ({
    pattern,
    match,
    purpose: 'api',
  });

  it('prefers an exact match over a suffix match', () => {
    const trie = new HostTrie();
    trie.add(vendorA, alias('example.com', 'suffix'));
    trie.add(vendorB, alias('api.example.com', 'exact'));
    expect(trie.lookup('api.example.com')?.vendor.id).toBe('b');
  });

  it('prefers the most specific suffix', () => {
    const trie = new HostTrie();
    trie.add(vendorA, alias('example.com', 'suffix'));
    trie.add(vendorB, alias('ingest.example.com', 'suffix'));
    expect(trie.lookup('x.ingest.example.com')?.vendor.id).toBe('b');
    expect(trie.lookup('other.example.com')?.vendor.id).toBe('a');
  });

  it('does not let an exact pattern match a subdomain of itself', () => {
    const trie = new HostTrie();
    trie.add(vendorA, alias('example.com', 'exact'));
    expect(trie.lookup('sub.example.com')).toBeNull();
  });
});
