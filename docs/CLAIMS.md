# What Egressa claims

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

That sentence is the whole contract. It lives in exactly one place in the codebase —
`packages/core/src/claims.ts` — and a test asserts it reaches every user-visible surface.

## What a finding means

A finding says: **this repository contains code that references a vendor, or configuration
declaring a region for infrastructure it controls, and here is what our sourced knowledge base
records about where that vendor processes data.**

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
- **Non-JavaScript surfaces.** Tag managers, CSP headers and native mobile code are out of scope.
  Infrastructure configuration is read for the regions it declares -- Terraform, Serverless,
  Vercel -- but only where a region is a literal; one supplied by a variable at deploy time is
  reported as absent rather than guessed.

## Surfaces whose scope is wider than transfers

`skill/privacy-review/` reviews consent, retention, logging, session replay and opt-out signals. The
sentence at the top of this file describes the *scanner*, so quoting its first clause on that surface
would misdescribe what the review looks at — but the refusal in its second clause applies to every
surface without exception.

So `claims.ts` exports that sentence on its own, as `NON_ASSESSMENT`, and every skill carries it
verbatim. `DISCLAIMER` is unchanged and still ends with it; a test asserts that, so the two cannot
drift apart into two different refusals.

The review skill adds one refusal of its own, in `skill/privacy-review/references/language-rules.md`:
it reports the pattern, the provision that pattern engages, and the question a human must answer. It
does not conclude that a provision was breached, because that depends on the legal basis, the
retention schedule, the processor agreements and what the person was actually shown — none of which
is in a repository.

## Enforcement

Four tests enforce this document:

1. `DISCLAIMER` appears verbatim in human output, the JSON `disclaimer` field, SARIF
   `tool.driver.fullDescription`, every rule's `help.markdown`, MCP tool descriptions, and the README.
2. No generated string contains a word from `FORBIDDEN_CLAIM_WORDS` — `compliant`, `violation`,
   `illegal`, `guarantees`, and similar. Each is a claim that leaps from "code references a vendor"
   to "data was sent" or "sending it was unlawful."
3. Every `SKILL.md` under `skill/` carries `NON_ASSESSMENT`, and no markdown shipped under `skill/`
   contains a forbidden word. The file list is computed by walking the tree, not hand-maintained, so
   a new specialist checklist cannot ship outside the contract by nobody remembering to register it.
   `references/language-rules.md` is exempt because it is the table that quotes the forbidden
   vocabulary deliberately — and that exemption is itself asserted, so a file stops being exempt if
   it stops being the vocabulary table.
4. The plugin's write-time hook makes no forbidden claim, emits no permission decision, and points
   the reader at the full review instead of concluding. It writes sentences about the law directly
   into a session and only speaks when it fires, which makes it the claim-bearing surface where
   drift would go unnoticed longest.

Language drift is the failure mode for tooling in this category. A test cannot drift.
