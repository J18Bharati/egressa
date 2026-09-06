import type { HostAlias, HostMatch, VendorEntry } from './types.js';

interface TrieNode {
  children: Map<string, TrieNode>;
  /** Set when a `suffix` pattern terminates here: matches this node and anything below. */
  suffix?: HostMatch;
  /** Set when an `exact` pattern terminates here. */
  exact?: HostMatch;
}

/**
 * Host index built as a reversed-label trie.
 *
 * Hosts are matched right-to-left ("com" -> "sentry" -> "ingest"), so a suffix
 * pattern like `ingest.sentry.io` matches `o4507.ingest.sentry.io` in a number
 * of steps equal to the label count rather than by scanning every pattern in the
 * knowledge base. That keeps matching linear in host length as the knowledge
 * base grows, which is the difference between a scan that stays fast at 34
 * vendors and one that does not at 500.
 *
 * An exact match always wins over a suffix match, and the most specific suffix
 * wins over a shorter one -- so a vendor can claim `de.sentry.io` precisely
 * while another pattern claims the broader domain.
 */
export class HostTrie {
  private readonly root: TrieNode = { children: new Map() };

  add(vendor: VendorEntry, alias: HostAlias): void {
    const labels = alias.pattern.split('.').reverse();
    let node = this.root;
    for (const label of labels) {
      let next = node.children.get(label);
      if (!next) {
        next = { children: new Map() };
        node.children.set(label, next);
      }
      node = next;
    }
    if (alias.match === 'exact') node.exact = { vendor, alias };
    else node.suffix = { vendor, alias };
  }

  /**
   * Resolve a host to a vendor. Returns null when nothing claims it, which the
   * caller reports as an unknown vendor rather than guessing.
   */
  lookup(host: string): HostMatch | null {
    const normalised = normaliseHost(host);
    if (!normalised) return null;

    const labels = normalised.split('.').reverse();
    let node: TrieNode | undefined = this.root;
    let deepestSuffix: HostMatch | null = null;
    let depth = 0;

    for (const label of labels) {
      node = node.children.get(label);
      if (!node) break;
      depth += 1;
      // Record the deepest (most specific) suffix seen on the way down.
      if (node.suffix) deepestSuffix = node.suffix;
      // An exact pattern only matches when the whole host is consumed.
      if (node.exact && depth === labels.length) return node.exact;
    }

    return deepestSuffix;
  }

  get size(): number {
    let count = 0;
    const visit = (node: TrieNode): void => {
      if (node.exact) count += 1;
      if (node.suffix) count += 1;
      for (const child of node.children.values()) visit(child);
    };
    visit(this.root);
    return count;
  }
}

/**
 * Lowercases, strips a trailing dot, a port, userinfo, and any leading `www.`
 * is deliberately NOT stripped -- `www.google-analytics.com` is a distinct
 * documented host from `google-analytics.com` and the knowledge base says so.
 */
export function normaliseHost(host: string): string | null {
  let value = host.trim().toLowerCase();
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at >= 0) value = value.slice(at + 1);
  const colon = value.indexOf(':');
  if (colon >= 0) value = value.slice(0, colon);
  value = value.replace(/\.$/, '');
  return /^[a-z0-9.-]+$/.test(value) && value.includes('.') ? value : null;
}
