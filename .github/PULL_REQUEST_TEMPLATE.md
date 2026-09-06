## What this changes

<!-- One or two sentences. -->

## For changes touching `kb/`

- [ ] Every factual field traces to a vendor- or regulator-published source, cited in `sources`
- [ ] `lastVerified` is set to the date I actually checked the sources
- [ ] I authored this entry from primary sources. **I did not copy it from Bearer Recipes,
      DuckDuckGo Tracker Radar, Ghostery TrackerDB, Disconnect, the IAB TCF vendor list, or any
      other database** (see `kb/PROVENANCE.md`)
- [ ] The entry contains facts only — no adjectives, no risk ratings
- [ ] `pnpm kb:validate` passes

## For changes touching detection

- [ ] Added or updated a fixture and its `expected.json`
- [ ] If this lifts a documented limitation, `docs/LIMITATIONS.md` and its golden test are updated
