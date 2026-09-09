# TODOS

Actionable engineering work. This is not `docs/ROADMAP.md`: the roadmap records **product scope
decisions** — what v1 deliberately excludes and what will never be built — while this file tracks
**work someone could pick up**. When an item here changes what the product claims to do, update the
roadmap too, and say so in the item.

## Distribution

### Create the GitHub repository and push

**What:** Create `github.com/egressa-dev/egressa`, push `v1-build`, then install the plugin from a
clean machine to confirm the documented path works.

**Why:** The README's primary install instruction cannot work today. There is no git remote at all,
so `/plugin marketplace add egressa-dev/egressa` resolves to nothing. Every install instruction in
the repository currently documents a 404, which is the worst possible first impression for a tool
whose entire pitch is precision.

**Context:** `git remote -v` is empty. Three files already name the org: `repository` in
`.claude-plugin/plugin.json`, the marketplace manifest, and `action.yml`, which pins
`uses: egressa-dev/egressa@v1`. The `egressa` GitHub org was confirmed free during the naming pass,
but nothing has been reserved — check again before assuming. `claude plugin validate .` passes
locally, which validates the manifests but not the install, because the install needs a remote.

**Effort:** S
**Priority:** P0
**Depends on:** None

### Decide whether to vendor the native parser binding

**What:** Either ship `oxc-parser`'s platform binaries inside `skill/privacy-review/bin/`, or decide
not to and document the bundle as manifest-only for good.

**Why:** The bundled CLI runs without the native parser, so it reports `engine.degraded` and reads
dependency manifests only. That misses any vendor called by URL without its SDK declared — precisely
the case call-site analysis exists to catch. Anyone installing the skill against their own project,
rather than working in this repo, gets the weaker scan.

**Context:** Roughly 2 MB per platform committed to git, about 8 MB for Linux, macOS and Windows.
`oxc-parser` lists 19 platform bindings in its `optionalDependencies`, so "all platforms" is not an
option. The degradation is graceful and loud since the lazy-import work, so doing nothing is
defensible — this is a size-versus-capability call, not a correctness one. Recorded as the single
open decision in `docs/ROADMAP.md`; update both files together.

**Effort:** M
**Priority:** P1
**Depends on:** None

## Knowledge base

### Grow the seed set from 5 vendors toward ~34

**What:** Author the remaining entries in batches of five or fewer, so review stays real.

**Why:** Coverage is the difference between a useful scan and a page of
`transfer/unknown-vendor-egress`. Five entries cover almost nothing a real repository contains, and
the `unmatched` block is the only recall signal there is, since the project has no telemetry.

**Context:** `kb/vendors/` holds google-analytics, mailgun, openai, sentry and stripe. The v1 plan's
M6 specified roughly 34 and lists the seed set: the analytics, error-tracking, email, payments,
identity, AI and infrastructure vendors most likely to appear. Entries are clean-room authored from
vendor and regulator primary sources only; `kb/PROVENANCE.md` lists the sources that must never be
incorporated, including Bearer Recipes and the CC BY-NC-SA tracker lists. `pnpm kb:validate` gates
schema, sourcing and alias collisions. Every new entry needs `lastVerified` and at least one source
with `publisher: vendor` or `regulator`.

**Effort:** XL
**Priority:** P1
**Depends on:** None

## Skills

### Validate the two specialists that have never been exercised

**What:** Run `opt-out-signals` and `transfers` against purpose-built fixtures with cold-context
agents, the way the other four were.

**Why:** Four of the six specialist checklists were validated by independent agents and all four
returned corrections that were folded back in — an unclassifiable severity tier, an untraceable
logger import, an ambiguous retention fallback, a framework-global mount misread as field evidence.
The two unvalidated ones have had no such pass, so their false-positive behaviour is unknown.

**Context:** `opt-out-signals` needs a fixture that actually passes its scope gate: an advertising or
cross-context tracker present, plus one variant that reads `Sec-GPC` and ignores it. `transfers`
needs a fixture where the scanner returns findings across several rules, so the mapping table in
`specialists/transfers.md` gets exercised — particularly that
`transfer/third-country-egress-eu-region-available` becomes a `config` finding with a question
rather than a fix.

**Effort:** S
**Priority:** P1
**Depends on:** None

### Add a staleness check to the skill

**What:** A preamble check that tells the user when their installed copy, and especially its bundled
knowledge base, has fallen behind.

**Why:** A stale privacy tool is worse than an absent one, because it reports against old vendor
facts while looking current. Adequacy status and vendor jurisdictions change; the code does not.

**Context:** gstack solves this with `bin/gstack-update-check`, and the lesson worth copying is that
it **fails loud**: silence is the up-to-date signal, so a crashing check was indistinguishable from a
current install and produced a 45-release silent-staleness incident. Their fix is an `ERR` trap that
prints `CHECK_FAILED ... status UNKNOWN`. `skill/privacy-review/bin/BUNDLE.json` already records
`toolVersion`, `kbVersion` and `bundledAt`, and `kb/adequacy-status.json` carries `asOf`, so the
inputs exist. Must be cached and snoozable, and must not reach the network without consent — the
same rule that keeps `EGRESSA_ALLOW_NPX` opt-in.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Engine

### Cover `--no-color` with a real assertion

**What:** Assert that colour is actually suppressed, from a context where it would otherwise be on.

**Why:** The flag was one of four that parsed and did nothing. The other three now have tests that
assert an observable difference; this one does not, because piped output is not a TTY and colour is
off anyway, so a passing test would prove nothing.

**Context:** `packages/cli/src/commands/scan.ts` declares `color` with a `true` default and passes
`args.color !== false` to `render`. The structural guard in `cli.test.ts` catches a `no-` prefixed
redeclaration, which is the failure mode that actually occurred, so the risk here is low. Testing it
properly means forcing colour on — a pseudo-terminal, or a seam in `formatHuman`.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Release

### Build the publishing pipeline

**What:** Changesets, `.npmrc`, and a release workflow with npm provenance via GitHub OIDC.

**Why:** Nothing is on npm, so `npx egressa`, `@egressa/mcp` and the MCP install line in
`docs/mcp.md` are all future tense. The docs say so now, but that is a stopgap.

**Context:** Deliberately deferred — distribution is the Claude Code plugin for now, which needs a
git ref rather than a registry. There is no `.changeset`, no `.npmrc`, and `.github/workflows/` holds
only `ci.yml`, `kb-validate.yml` and `link-check.yml`. `SECURITY.md` describes the provenance
verification step as future, and must be updated when this lands. The published tarball needs a smoke
test from a clean container, since the bundle's shape has changed twice.

**Effort:** M
**Priority:** P2
**Depends on:** Create the GitHub repository and push

### Start a CHANGELOG

**What:** A `CHANGELOG.md`, written from the point the first tag exists.

**Why:** The knowledge base is versioned data that people will pin and diff. Changes to vendor facts
matter to anyone who acted on a previous scan, and a rename has already happened once.

**Context:** No changelog exists. Commit messages are currently the only record, and they are
detailed but not user-facing. Should distinguish engine changes from knowledge-base changes, since a
KB update can change findings without any code moving.

**Effort:** S
**Priority:** P3
**Depends on:** Build the publishing pipeline

## Completed

### Rename the project to Egressa
**Completed:** v1-build (2026-09-09) — `adequacy.app` was an occupied name. Done token by token,
because "adequacy" is also a GDPR term of art; the legal-vocabulary counts were asserted unchanged.

### Fix four inert CLI flags
**Completed:** v1-build (2026-09-09) — `--no-dev`, `--no-callsites`, `--no-manifests` and
`--no-color` parsed and did nothing for all of v1, because citty already implements `--no-x` as
negation. Each now has a behavioural test, plus a structural guard against the class.

### Make the native parser optional
**Completed:** v1-build (2026-09-09) — `engine.degraded` was unreachable dead code and could not
have worked, since a static ESM import fails at link time where no `try`/`catch` can see it. Now a
guarded top-level `await import()`, with a forced-failure test.

### Package as a Claude Code plugin with a write-time hook
**Completed:** v1-build (2026-09-09) — plugin and marketplace manifests, plus a `PreToolUse` hook
that never blocks and stays silent on strictly-necessary storage, gated edits, tests and fixtures.

### Build the privacy-review skill
**Completed:** v1-build (2026-09-09) — orchestrator plus six specialist checklists covering consent,
retention, logs, session replay, opt-out signals and transfers, inside the claims contract.
