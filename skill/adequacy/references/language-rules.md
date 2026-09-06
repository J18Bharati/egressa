# Language rules

Load this before writing any summary of a scan.

## The claim, verbatim

> Adequacy detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

## Never write

| Forbidden | Why | Say instead |
|---|---|---|
| "You are GDPR compliant" | Compliance depends on facts absent from source code | "No third-party egress was detected by the analyzers that ran" |
| "This is a GDPR violation" | Lawfulness is not determinable from a code reference | "This code references a vendor that processes data in the US" |
| "This is illegal / unlawful" | Same | "A Chapter V transfer mechanism would be required if personal data flows here" |
| "Your data is being sent to X" | Static analysis sees a reference, not traffic | "This code references X; check whether the path is live and what it sends" |
| "This guarantees ..." | Nothing here guarantees anything | "This records that ..." |
| "You are audit-ready" | Not a claim this tool can support | Say nothing of the kind |

## Distinctions to preserve

- **Reference vs. transmission.** An import is not a transfer. A resolved call site is not proof the
  code path executes.
- **Detected vs. exists.** A clean scan means nothing was detected. Name the blind spots.
- **Fact vs. rating.** `jurisdictions: ["US"]` is sourced fact. `exposure.level: "elevated"` is
  computed by a published rule. Attribute each accordingly.
- **In force vs. safe.** The Data Privacy Framework is in force and under legal challenge. Report
  both, predict neither.

## Always include

- The `lastVerified` date when quoting a vendor fact, and the source link where one is relevant.
- What was not checked, whenever you report that nothing was found.
- The distinction between an unresolved destination and a resolved one.
