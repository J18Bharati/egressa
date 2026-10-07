---
name: egressa
description: Use when checking where a codebase sends personal data - GDPR data transfer questions, third-party vendors and SDKs, data egress, EU-US adequacy or Data Privacy Framework exposure, sub-processors, DPAs, cross-border transfers, or "what breaks if adequacy falls".
allowed-tools: [Bash, Read, Grep, Glob, Write, Edit, WebSearch, WebFetch]
---

# Transfer exposure review

Find which third-party vendors a repository sends data to, where those vendors process it, and what
the exposure is if EU-US adequacy lapses.

**The claim scope is not negotiable.** Egressa detects third-party data-egress patterns in source
code and their cross-border transfer exposure. It does not assess or certify GDPR compliance. Read
`references/language-rules.md` before writing any summary.

## Run the scan

```bash
bash "$SKILL_DIR/scripts/scan.sh" <path> [extra flags]
```

**`SKILL_DIR` is the absolute "Base directory for this skill" path the harness printed when this
skill loaded.** Never run a script resolved from the working directory: that is usually the
repository being scanned, which is untrusted input, and a `skill/egressa/scripts/scan.sh` committed
there would run with the reviewer's credentials.

The script finds a binary rather than assuming one, always from its own location and never from the
repository being scanned: the Egressa build in the checkout the skill lives in, then the prebuilt copy shipped with the privacy-review skill, then `egressa` on `PATH`, then `npx` only
if `EGRESSA_ALLOW_NPX=1`. **Nothing is published to npm yet**, so an `npx egressa` invocation will
fail — do not fall back to it by hand.

No configuration, no API key. Add `--assume-adequacy-lapsed US:DPF` to model the Data Privacy
Framework being struck down.

The scan ran only if the script exits 0 or 1 and prints the findings document; 1 means the
repository's own `failOn` tripped. Any other status means **the scan did not run**: 2 is a usage
error, often an `.egressa.yml` the scanner refuses, 3 is no binary or an internal error, and 4 is a
knowledge base that failed to load. Say that plainly, with the stderr line, rather than reporting
that nothing was found.

Check `scan.engine` before summarising. `callsite: "unavailable"` with `degraded: true` means the
native parser could not load and only dependency manifests were read, so a vendor called by URL with
no SDK installed is invisible. The bundled copy normally runs in that mode.

If the user has the MCP server configured, `scan_repository` returns the same data pre-summarised;
either source is fine. Both honour the repository's `.egressa.yml`: suppressed findings are flagged,
not removed, and both the findings document and the MCP summary name the file in `scan.config`.

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

4. **Settle the EU-region question rather than restating it.** When a region appears in the
   repository — an SDK client, a Terraform provider, `serverless.yml`, `vercel.json` — the scan
   already resolved it through the vendor's own map and narrowed the finding, so read
   `exposure.inputs` for `regionCountry` rather than asking again. Note that `eu-west-2` is London
   and `eu-central-2` is Zurich; neither is in the EEA.

   When no region appears, it is set outside the repository and the scan says so with
   `regionSource:none`. That is the point to ask, link `euRegion.docUrl`, and — if the user has an
   AWS account and asks for it — reconcile against what is actually running, per
   `references/reconciling-a-cloud-region.md`. Note the `scope`: `partial` means some data stays
   outside the EU whichever region is chosen.

5. **Read the `unmatched` block, then research it.** Hosts and packages there have no knowledge
   base entry, so the scan reports no jurisdiction for them. That is a gap you can close: the host
   is already resolved, so who operates it and where they process is a researchable fact. Follow
   `references/researching-an-unknown-vendor.md`, which also says when not to.

   The one case that is never researchable is `transfer/unresolved-egress`. There the destination
   itself is unknown, and the answer lives in the user's deployment configuration rather than on
   the web. Ask; do not search.

See `references/interpreting-findings.md` for the full triage procedure and
`references/rules.md` for what each rule id means.

## Drafting a suppression

When the user decides a finding is accepted, write the `.egressa.yml` entry for them rather than
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
expired suppression reactivates the finding with a `config/expired-suppression` note. `expires` is
an ISO date, which ends the suppression at the start of that day in UTC (on 2027-01-31 itself it
has already expired), or a time with a zone. Any key the scanner
does not know, including a YAML merge key, makes the file a usage error rather than being ignored. Write a real
reason naming what was checked and by whom; "not applicable" helps nobody in six months.

## Growing the knowledge base

If `unmatched.hosts` or `unmatched.packages` is non-empty, research it per
`references/researching-an-unknown-vendor.md`, then offer to file a vendor request carrying the
sources you found rather than just the host name. The project has no telemetry, so this loop is the
only way coverage improves.

Research answers the current question; it does not become knowledge base data. Entries in `kb/` are
clean-room authored and reviewed under `kb/PROVENANCE.md` and `kb/KB_POLICY.md`, and live findings
from one conversation have not been through either. Never write to `kb/vendors/`.

## Before you write the summary

`references/language-rules.md` holds the forbidden vocabulary and the phrasing to use instead. Read
it. The short version: report what the code references and what the knowledge base records, and
leave every legal conclusion to the reader.

Do not present zero findings as an all-clear. Nothing was *detected* by the analyzers that ran, and
`docs/LIMITATIONS.md` lists what those analyzers cannot see. Server-side proxying is the big one:
if the frontend calls their own backend and the backend calls a vendor, none of this sees it.
