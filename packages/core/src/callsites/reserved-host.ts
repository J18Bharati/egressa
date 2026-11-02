/**
 * Hosts that cannot name a third party, because a standard reserves them.
 *
 * - `localhost` and any name under it, and the IPv4 and IPv6 loopback
 *   addresses: RFC 6761 section 6.3 and RFC 6890. A request to one never
 *   leaves the machine.
 * - `example.com`, `example.net`, `example.org` and the `test`, `example` and
 *   `invalid` top-level names, with every name under them: RFC 2606 and RFC
 *   6761 sections 6.2, 6.4 and 6.5. They are reserved for documentation and
 *   testing and are not delegated to anyone who could receive data.
 *
 * Private address ranges are deliberately not here. `10.0.0.5` can be a
 * vendor's appliance inside a VPC, so it stays an unknown destination for a
 * human to check; a reserved name cannot be anyone's.
 */
const RESERVED_SUFFIXES = ['localhost', 'test', 'example', 'invalid'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

export function isReservedHost(host: string): boolean {
  const value = host.toLowerCase().replace(/\.$/, '');
  if (value === '[::1]' || value === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(value)) return true;
  const label = value.slice(value.lastIndexOf('.') + 1);
  if (RESERVED_SUFFIXES.includes(label)) return true;
  return RESERVED_DOMAINS.some((d) => value === d || value.endsWith(`.${d}`));
}
