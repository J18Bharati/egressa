# Researching a vendor the knowledge base does not know

The knowledge base is a curated seed set, not a census. A real repository will reference vendors it
has no entry for, and the scanner reports those as `transfer/unknown-vendor-egress` or leaves them
in the `unmatched` block. That is honest, and it is also unhelpful on its own.

This procedure turns "no entry" into a sourced answer for the current conversation. It does not
turn it into a knowledge base entry — see [What this is not](#what-this-is-not).

## When this applies, and when it does not

Run this **only** for a vendor whose identity is already settled by the scan:

| Situation | Research it? |
|---|---|
| `transfer/unknown-vendor-egress` with a resolved host | **Yes.** The host is a fact; who operates it is researchable. |
| A package name in `unmatched.packages` | **Yes.** The registry page names a repository and an author. |
| A host in `unmatched.hosts` | **Yes.** |
| `transfer/unresolved-egress` | **No. Never.** |

The last row is the important one. `transfer/unresolved-egress` means the destination came from a
variable and `unresolvedReason` names it — `host supplied by environment variable ANALYTICS_URL`.
No amount of web research reveals what that variable holds at deploy time, because the answer is
not on the web. It is in the user's configuration. Researching a plausible vendor for it and
reporting one would be inventing a recipient, which is the failure `resolve-host.ts` refuses at the
engine level, reintroduced by hand one layer up. Ask the user what the variable is set to.

Also skip a host that is plainly the user's own infrastructure, or a well-known non-recipient — a
package registry, a CDN serving the user's own assets, a documentation domain.

## The procedure

Work from primary sources, in this order. Stop when you have the fact or have established that it
is not published.

**1. Establish who operates it.** Fetch the host's homepage, and for a package its registry page and
linked repository. You are looking for a **legal entity**, not a brand: "Functional Software, Inc."
rather than "Sentry". A trading name with no entity behind it is a gap — record it as one.

**2. Find the processing locations.** Look for a sub-processor list, a security or trust page, and
the data-processing addendum. Record the countries the vendor itself names. Do not infer a location
from where a request appears to terminate — a CDN edge is not a processing location, and reading one
as a jurisdiction is a guess dressed as evidence.

**3. Check for an EU region.** If the vendor documents one, capture the URL and the **scope**: does
it cover the whole product, part of it, or only certain features? Every vendor that has one is
partial in a different way, and "EU region available" without the scope is close to useless. If you
cannot find one, that means no such option appears on the pages you checked — not that the vendor
has stated none exists. Write the first, never the second.

**4. Check the Data Privacy Framework list.** Search <https://www.dataprivacyframework.gov/list> for
the legal entity from step 1. Record:

- whether a certification exists **and is Active** — a lapsed certification does not cover new
  transfers, and the list shows status;
- **which** framework, since EU-US, the UK Extension and Swiss-US are three separate certifications
  and an organisation may hold one and not another.

If the registry does not load or returns nothing usable, say exactly that and record the vendor as
not established rather than not certified. The two are different and the difference decides the
finding.

**5. Find the transfer mechanism.** DPF, standard contractual clauses, binding corporate rules. Most
vendors state this in the DPA or a transfers page. A vendor may rely on more than one.

## Reporting what you found

Report it as **research, not as knowledge base data**, and label it that way in the output. Give
each fact its source URL inline, so the reader can check any single line without trusting the whole.

State your confidence in the identification separately from the facts. "The host `api.example.io`
resolves to Example Ltd." can be solid while "Example Ltd processes in the US" is thin. Where a fact
is not published, write that it is not published — an explicit gap is worth more than a confident
sentence, and it tells the user what to ask the vendor.

Two things to keep out of the output. Do not state a jurisdiction you inferred rather than read; if
the vendor does not say where it processes, that absence *is* the finding. And do not carry a
conclusion further than the facts reach — this procedure establishes where a vendor says it
processes data, which is a smaller claim than what follows from that, and the smaller claim is the
one to write down.

## Offering the entry back

When the research produced something solid, offer to file a vendor request using
`.github/ISSUE_TEMPLATE/vendor-request.yml`, with the sources you gathered already filled in. Draft
it; do not file it without being asked.

The project has no telemetry, so this loop is the only route by which coverage improves. A request
carrying four verified URLs is worth considerably more than one carrying a host name.

## What this is not

This does not write to `kb/`, and you must not offer to.

Entries there are clean-room authored under `kb/PROVENANCE.md`, reviewed under `kb/KB_POLICY.md`,
carry a `lastVerified` date and a staleness rule, and are licensed CC-BY-4.0 for other tools to
build on. Live research inside one conversation meets none of those conditions. Writing it into
`kb/vendors/` would put an unreviewed fact behind the same citation furniture as a reviewed one,
and a reader has no way to tell them apart afterwards.

Two specific prohibitions carry over from `kb/PROVENANCE.md` and apply to research just as they do
to authoring. Do not source facts from Bearer Recipes, DuckDuckGo Tracker Radar, Ghostery TrackerDB,
Disconnect, or the IAB TCF Global Vendor List: their licences are incompatible with the knowledge
base, and copying from them into a report is the same act as copying them into the data. And do not
treat another scanner's classification as a source. Cite the vendor or the regulator, or record the
gap.

Finally, the claim scope is unchanged by research. Establishing that a vendor processes in a third
country is a fact about the vendor. It is not a conclusion about the user's position, and
`references/language-rules.md` governs the write-up exactly as it governs everything else.
