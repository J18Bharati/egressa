# Knowledge base policy

The knowledge base makes factual statements about named companies. This document says how those
statements are made, and how they get corrected.

## What entries may contain

Entries record **only what the vendor or a regulator publishes**, with a URL and an access date for
each claim. Permitted sources:

- The vendor's own DPA, trust center, security page, sub-processor list, or product documentation
- Regulator publications: European Commission adequacy decisions, the Data Privacy Framework
  participant list, EDPB guidance

Entries state facts and cite them. **No adjectives.** No "risky", "avoid", "problematic". Anything
evaluative is computed by the published rule table in `docs/METHODOLOGY.md`, not written here.

## Corrections

If an entry is wrong, it is a bug, and we would rather fix it than argue about it.

| Step | Commitment |
|---|---|
| You open a correction issue | Acknowledged within **2 business days** |
| The entry is contested in good faith | Marked `disputed` **immediately, before review concludes**, with a link to your issue. The marker is surfaced in CLI and SARIF output. |
| You supply a primary source showing the correct value | Merged **same day** |
| We cannot reproduce your claim | We say so publicly in the issue and leave the `disputed` marker in place while it is discussed |

Use the [vendor correction template](../.github/ISSUE_TEMPLATE/vendor-correction.yml). You do not
need a GitHub account to be taken seriously — email works, and we will file the issue on your
behalf and credit it.

**We would rather mark an entry disputed and be wrong about the dispute than leave a contested
claim standing unmarked.** Correction is deliberately cheaper and faster than escalation.

## Staleness

Vendor hosting, DPAs and sub-processor lists change. Entries older than 180 days are surfaced as
`kb/stale-entry` findings at scan time rather than presented as current. A nightly job checks that
every cited URL still resolves and files an issue when one does not.

## What we will not do

- We will not publish a claim we cannot cite to a primary source.
- We will not rate vendors editorially in the data layer.
- We will not accept data copied from another project's database (see `PROVENANCE.md`).
