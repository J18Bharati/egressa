# Provenance and clean-room policy

The knowledge base is **independently authored**. This document exists so that the sourcing of
every entry can be audited, and so there is a written record of what we deliberately do not use.

## Permitted sources

1. **Vendor primary sources** — the vendor's own DPA, trust center, sub-processor page, data
   residency documentation, or product docs. Cited with `publisher: "vendor"`.
2. **Regulator primary sources** — European Commission adequacy decisions, the Data Privacy
   Framework participant list, EDPB and national DPA publications. Cited with
   `publisher: "regulator"`.

Every factual field must trace to one of these. An entry with no vendor- or regulator-published
source fails CI.

## Forbidden sources

These datasets may **never** be used as a source of data, in whole or in part:

| Dataset | License | Why excluded |
|---|---|---|
| Bearer Recipes | Elastic License v2 | Source-available, not open source; restricts competing services |
| DuckDuckGo Tracker Radar | CC BY-NC-SA 4.0 | Non-commercial clause is incompatible with CC-BY-4.0 redistribution |
| Ghostery TrackerDB | CC BY-NC-SA 4.0 | Same |
| Disconnect tracker lists | CC BY-NC-SA 4.0 | Same |
| IAB Europe TCF Global Vendor List | TCF policies, not an open data license | Terms unresolved; may be used manually as a *lead list* only, never imported |

Those projects may appear in an entry's `sources` array as a **pointer** where they are the origin
of a claim we then verified ourselves at the vendor — never as the origin of the data itself.

## Why this matters

Egressa publishes a CC-BY-4.0 dataset intended for anyone, including competing tools, to build on.
That promise is only real if every field is ours to license. A single copied record would make the
whole dataset unredistributable, and would be indistinguishable from the conduct this project's
correction policy exists to avoid.

## Contributor attestation

Every pull request touching `kb/` carries a checkbox affirming the entry was authored from primary
sources and not copied from another database. `CODEOWNERS` requires maintainer review on `kb/**`.
