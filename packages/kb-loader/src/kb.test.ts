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
