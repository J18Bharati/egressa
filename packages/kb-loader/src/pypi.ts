/**
 * PEP 503 normalisation: lower case, and any run of `-`, `_` or `.` becomes one
 * `-`. PyPI treats `Twilio`, `twilio` and `TWILIO` as one project, so the
 * knowledge base stores the normalised form, every reader emits it, and a
 * lookup normalises what it is asked before comparing.
 *
 * It lives here rather than in core because core depends on this package, and
 * the lookup, the validator and the manifest reader all need the same rule.
 */
export function normalisePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}
