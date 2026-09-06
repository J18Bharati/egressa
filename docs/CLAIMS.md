# What Adequacy claims

> Adequacy detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

That sentence is the whole contract. It lives in exactly one place in the codebase —
`packages/core/src/claims.ts` — and a test asserts it reaches every user-visible surface.

## What a finding means

A finding says: **this repository contains code that references a vendor, and here is what our
sourced knowledge base records about where that vendor processes data.**

It does not say, and cannot say:

| A finding does not mean | Why not |
|---|---|
| Personal data was actually sent | Static analysis sees a reference, not traffic. The code path may be dead, feature-flagged, or test-only. |
| The data sent was personal data | We do not perform PII taint analysis in v1. `dataCategories` records what a vendor *typically* collects, not what you send. |
| Your use is unlawful | Lawfulness depends on your legal basis, your DPA, your configuration, and facts not present in source code. |
| A clean scan means you are compliant | Absence of findings means absence of *detected* patterns. See the limitations below. |

## What a clean scan means

Only that no known vendor was matched by the analyzers that ran. The structural blind spots are
real and documented:

- **Server-side proxying.** If your frontend calls your own backend, which calls the vendor, and
  that backend is not in the scanned repo, the transfer is invisible.
- **Runtime-configured hosts.** Destinations from environment variables are reported as
  `transfer/unresolved-egress` and never guessed.
- **Vendors not in the knowledge base.** Reported as `transfer/unknown-vendor-egress`. The
  knowledge base is a seed set, not a census.
- **Non-JavaScript surfaces.** Tag managers, CSP headers, native mobile code, and infrastructure
  configuration are out of scope in v1.

## Enforcement

Two tests enforce this document:

1. `DISCLAIMER` appears verbatim in human output, the JSON `disclaimer` field, SARIF
   `tool.driver.fullDescription`, every rule's `help.markdown`, MCP tool descriptions, and the README.
2. No generated string contains a word from `FORBIDDEN_CLAIM_WORDS` — `compliant`, `violation`,
   `illegal`, `guarantees`, and similar. Each is a claim that leaps from "code references a vendor"
   to "data was sent" or "sending it was unlawful."

Language drift is the failure mode for tooling in this category. A test cannot drift.
