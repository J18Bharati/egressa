# Interpreting findings

## Read severity and confidence separately

They are orthogonal and both matter.

- **Severity** comes from knowledge base facts about the vendor: where it processes, whether an
  adequacy decision covers it, whether an EU region exists.
- **Confidence** comes from how the signal was obtained.

| Confidence | Means | How to treat it |
|---|---|---|
| `high` | Resolved call-site host, or a direct dependency on the vendor's own SDK | Report it plainly |
| `medium` | Wrapper or framework-integration package, a host resolved through a client binding, or a dev-only dependency | Report it, and say how it was inferred |
| `low` | Transitive dependency, or an unresolved destination | Frame as "worth checking", never as established |

A `low`-confidence finding on a US vendor and a `high`-confidence one carry the same severity and
very different weight. Do not let the severity flatten them.

## Triage procedure

For each finding, in order:

1. Open every file in `evidence[]` at the given line.
2. Classify the call site: production path, test, example, dead branch, or commented out.
3. If production, look at what is passed. Does it plausibly carry personal data? Say what you saw.
4. Check `exposure.inputs` to see exactly which facts produced the rating — it lists jurisdictions,
   EU-region scope, transfer mechanisms, the adequacy decision status, and `dpfCertified`.
5. Check `lastVerified`. If the entry is stale the scan will also emit `kb/stale-entry`.
6. If `disputed` is set, lead with that: the vendor has contested this entry and it is under review.

## Rule-specific handling

- **`transfer/adequate-country-egress`** — covered today, but `adequacyDependent` is true. Mention
  that re-running with `--assume-adequacy-lapsed US:DPF` shows the position if the framework falls.
- **`transfer/third-country-egress-eu-region-available`** — the actionable one. The scanner cannot
  see which region the account uses. Make checking it a concrete step, and read `euRegion.scope`:
  `partial` means some categories stay outside the EU regardless of the setting.
- **`transfer/third-country-egress`** — no EU alternative is documented. The question is the
  transfer mechanism, not configuration.
- **`transfer/unresolved-egress`** — name the environment variable from `unresolvedReason` and stop.
  Do not speculate about which vendor it is.
- **`transfer/unknown-vendor-egress`** — a knowledge base gap, not a statement about the vendor.
- **`kb/stale-entry`** — the facts may have moved. Check the sources before relying on them.

## What the scanner structurally cannot see

Say these plainly whenever you report that little or nothing was found:

- **Server-side proxying.** Frontend calls own backend, backend calls the vendor. Invisible unless
  the backend is in the same repository. This is the largest gap.
- **Runtime-configured hosts**, reported as unresolved rather than guessed.
- **Vendors with no knowledge base entry.**
- **Tag managers, CSP headers, native mobile code, infrastructure config** — all out of scope in v1.
- **Minified and bundled output**, deliberately skipped.
