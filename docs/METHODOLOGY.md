# Methodology

How Egressa gets from source code to a finding, and where judgment enters.

## 1. Facts come from primary sources

Every knowledge base entry records only what a vendor or a regulator publishes, with a URL and an
access date for each claim. Entries state facts and cite them; they contain no adjectives. See
`kb/PROVENANCE.md` for the sourcing rules and the list of datasets we deliberately do not use.

## 2. Exposure is computed, never authored

Knowledge base entries do not carry a risk rating. Exposure is derived from the facts by a
versioned rule table in `packages/core/src/exposure/rules.ts`, and each finding records the exact
fact tuple that produced it in `exposure.inputs`.

This matters for disputes. A vendor objecting to `thirdCountryTransfer: true` is objecting either
to a fact — settled by checking the cited URL — or to a published rule in this document. Neither
is a matter of opinion about the vendor.

**Flags are primary; `exposure.level` is derived convenience.** Prefer the flags when acting on a
finding.

### The rule table (v1.0.0)

| Facts | Flags | Rule |
|---|---|---|
| All jurisdictions in EEA | none set | `transfer/eu-processing` |
| Every non-EEA jurisdiction covered by a decision that applies to this vendor | `adequacyDependent` | `transfer/adequate-country-egress` |
| Not covered, EU region documented | `thirdCountryTransfer`, `euAlternativeAvailable` | `transfer/third-country-egress-eu-region-available` |
| Not covered, no EU region | `thirdCountryTransfer` | `transfer/third-country-egress` |

`adequacyDependent` is set when the *only* thing standing between a vendor and a Chapter V transfer
question is an adequacy decision — which is exactly the population that changes if adequacy lapses.

**"Applies to this vendor" is doing real work in that table.** Country-level adequacy decisions
(Japan, Switzerland, Uruguay, …) cover every recipient in that country. The EU-US Data Privacy
Framework does not: it covers only organisations that have self-certified and appear on the DPF
list. So a US vendor is treated as covered *only* when its own entry records
`dpfCertified: true` from a primary source. A US vendor whose pages cite standard contractual
clauses instead is reported as third-country egress, because that is what its own documentation
says it relies on.

The certification check is recorded in `exposure.inputs` as `dpfCertified:true|false`, so the
reasoning behind any rating can be read off the finding.

### Decisions under legal challenge

A decision with status `under-challenge` is treated as **in force**. It still has legal effect, and
recording otherwise would be a prediction about how litigation will end. The challenge itself is
recorded factually in the decision's `notes` in `kb/adequacy-status.json`, with citations, so a
reader can see the situation without the tool taking a position on it.

To see the other side of that question, run with `--assume-adequacy-lapsed`. It treats the named
decision as withdrawn and re-rates every affected vendor, without any special-casing of the
hypothetical: the flag changes one field of data and the same rule table does the rest.

## 3. Adequacy status is data, not code

European Commission adequacy decisions and DPF status live in `kb/adequacy-status.json`, dated and
sourced, and are joined at scan time. This is deliberate: adequacy decisions are revocable and two
predecessors of the current EU-US framework were struck down. Running with
`--assume-adequacy-lapsed` re-rates every affected finding as if the named decision were withdrawn,
which is a data change rather than a code change.

## 4. Severity and confidence are orthogonal

**Severity** comes from knowledge base facts about the vendor. **Confidence** comes from how the
signal was obtained:

| Confidence | Signal |
|---|---|
| `high` | Resolved call-site host matching a host pattern; direct dependency on an official SDK |
| `medium` | Wrapper or plugin package; host resolved via a client binding or a 2–3 step constant chain; dev-only dependency |
| `low` | Transitive dependency; `<script src>` extraction; degraded-parser fallback |

A transitive dependency on a US vendor and a resolved call site to the same vendor carry identical
severity and very different confidence. Both are reported; neither is presented as the other.

## 5. Corrections

Any factual error is a bug. `kb/KB_POLICY.md` sets out the correction process, including that an
entry is marked `disputed` on any good-faith objection *before* review concludes, and that the
marker is surfaced in CLI and SARIF output.
