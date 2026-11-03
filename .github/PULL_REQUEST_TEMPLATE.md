## What this changes

<!-- One or two sentences. -->

## For changes touching `kb/`

- [ ] Every factual field traces to a vendor- or regulator-published source, cited in `sources`
- [ ] `lastVerified` is set to the date I actually checked the sources
- [ ] I authored this entry from primary sources. **I did not copy it from Bearer Recipes,
      DuckDuckGo Tracker Radar, Ghostery TrackerDB, Disconnect, the IAB TCF vendor list, or any
      other database** (see `kb/PROVENANCE.md`)
- [ ] The entry contains facts only — no adjectives, no risk ratings
- [ ] Any DPF status is copied verbatim from the participant record, which is the cited `url`
- [ ] Contributed under CC-BY-4.0, like the rest of `kb/`
- [ ] If drafted with `egressa facts contribute`, its checklist is ticked here too, and the draft
      names no person and carries nothing from my own codebase
- [ ] `pnpm kb:validate` passes

A maintainer re-reads every cited source before merging and sets `lastVerified` to that date.

## For changes touching code

- [ ] `pnpm verify` passes
- [ ] Contributed under the MIT License

## For changes touching detection

- [ ] Added or updated a fixture and its `expected.json`
- [ ] If this lifts a documented limitation, `docs/LIMITATIONS.md` and its golden test are updated
