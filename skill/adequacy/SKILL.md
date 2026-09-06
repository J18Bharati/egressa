---
name: adequacy
description: Use when checking where a codebase sends personal data - GDPR data transfer questions, third-party vendors and SDKs, data egress, EU-US adequacy or Data Privacy Framework exposure, sub-processors, DPAs, cross-border transfers, or "what breaks if adequacy falls".
---

# Transfer exposure review

Find which third-party vendors a repository sends data to, where those vendors process it, and what
the exposure is if EU-US adequacy lapses.

**The claim scope is not negotiable.** Adequacy detects third-party data-egress patterns in source
code and their cross-border transfer exposure. It does not assess or certify GDPR compliance. Read
`references/language-rules.md` before writing any summary.

## Run the scan

```bash
npx -y adequacy@latest scan . --format json
```

No install, no configuration, no API key. Add `--assume-adequacy-lapsed US:DPF` to model the
Data Privacy Framework being struck down.

If the user has the MCP server configured, `scan_repository` returns the same data pre-summarised;
either source is fine.

## Then do the part the scanner cannot

The scanner reports that code *references* a vendor. It cannot tell whether that code runs. You
can, by reading the files. This is the entire reason to use this skill rather than just running the
binary.

Work through the findings in this order:

1. **Triage each call site.** Open every file in `evidence[]`. For each one, decide: is this live
   production code, a test, an example, a commented-out block, or a dead branch behind a flag that
   is never on? Say which. A finding in `__tests__/` is not the same as one in a checkout handler.

2. **Check the direction of the data.** A vendor SDK being imported does not mean personal data
   flows to it. Look at what is actually passed. `fetch('https://api.stripe.com/v1/prices')`
   retrieving a price list is a different fact from one posting a customer email — report the
   difference rather than flattening it.

3. **Handle unresolved findings properly.** For every `transfer/unresolved-egress`, the destination
   comes from configuration, and `unresolvedReason` names the variable. Say which variable, and
   that the user must check their deployment configuration. Never guess the host.

4. **Point at the EU-region question.** When `euRegion.available` is true, the scanner cannot tell
   which region the account is actually on. Say so, link `euRegion.docUrl`, and make "check which
   region this project uses" a concrete next step. Note the `scope` — `partial` means some data
   stays outside the EU regardless.

5. **Read the `unmatched` block.** Hosts and packages there have no knowledge base entry, so no
   jurisdiction can be reported. Offer to open a vendor request issue (see below).

See `references/interpreting-findings.md` for the full triage procedure and
`references/rules.md` for what each rule id means.

## Drafting a suppression

When the user decides a finding is accepted, write the `.adequacy.yml` entry for them rather than
making them hand-edit YAML:

```yaml
version: 1
suppressions:
  - vendor: sentry
    rule: transfer/third-country-egress-eu-region-available
    reason: "Organisation is on the EU (Frankfurt) region; verified in console 2026-09-06. Ticket PRIV-412."
    acceptedBy: "name@example.com"
    expires: 2027-03-01
```

`reason` is required by schema. Always set `expires` — an accepted risk should be revisited, and an
expired suppression reactivates the finding with a `config/expired-suppression` note. Write a real
reason naming what was checked and by whom; "not applicable" helps nobody in six months.

## Growing the knowledge base

If `unmatched.hosts` or `unmatched.packages` is non-empty, offer to file a vendor request with the
host and the file it appeared in. The project has no telemetry, so this loop is the only way
coverage improves.

## Before you write the summary

`references/language-rules.md` holds the forbidden vocabulary and the phrasing to use instead. Read
it. The short version: report what the code references and what the knowledge base records, and
leave every legal conclusion to the reader.

Do not present zero findings as an all-clear. Nothing was *detected* by the analyzers that ran, and
`docs/LIMITATIONS.md` lists what those analyzers cannot see. Server-side proxying is the big one:
if the frontend calls their own backend and the backend calls a vendor, none of this sees it.
