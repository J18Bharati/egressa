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

### Grow the seed set from 15 vendors toward ~34

**What:** Author the remaining entries in batches of five or fewer, so review stays real.

**Why:** Coverage is the difference between a useful scan and a page of
`transfer/unknown-vendor-egress`, and the `unmatched` block is the only recall signal there is,
since the project has no telemetry.

**Context:** `kb/vendors/` holds anthropic, auth0, clerk, datadog, google-analytics, mailgun,
openai, posthog, resend, segment, sentry, stripe, supabase, twilio and vercel. The v1 plan's M6
specified roughly 34. Named gaps a real repository hits immediately: SendGrid (already unmatched in
a fixture), Amplitude, Mixpanel, Intercom, Algolia, Cloudflare, AWS, Google Cloud, Firebase,
LaunchDarkly, Slack, HubSpot.

Entries are clean-room authored from vendor and regulator primary sources only; `kb/PROVENANCE.md`
lists the sources that must never be incorporated. `pnpm kb:validate` gates schema, sourcing and
alias collisions, and `pnpm kb:coverage` reports the matched fraction over the fixtures.

Two things learned authoring the last ten. The DPF list at `dataprivacyframework.gov` renders
client-side and returns nothing to a fetch; its participant records are readable through the JSON
API the published site's own bundle calls, and the participant URL is what belongs in `sources`.
And `dpfCertified` is a single boolean that cannot express *Active*, *Active — re-certification
under review*, or *active now but lapsed for two years* — record the distinction in `notes` until
the field is restructured.

**Effort:** L
**Priority:** P1
**Depends on:** None

### Restructure `dpfCertified` from a boolean to a record

**What:** Replace `dpfCertified: boolean` with a structured value carrying framework (EU-US, UK
Extension, Swiss-US), status, and certification dates.

**Why:** The three frameworks are separate certifications and an organisation may hold one and not
another — Mailgun has EU-US and the UK Extension but no Swiss-US; Resend the same. A certification
can also be *Active — re-certification under review* (Okta, Resend today), or active now having
lapsed for two years (Vercel, 2022-07-08 to 2024-05-06). `exposure/rules.ts` gates the whole DPF
decision on this one boolean, so everything it cannot express is currently prose in `notes` that no
rule can read.

**Context:** `vendorIsDpfCertified()` in `packages/core/src/exposure/rules.ts` is the only consumer.
A certification expiry field would also let staleness fire on a lapse: Mailgun's record carries
`UsageEndDate 2027-01-26`, which is inside this knowledge base's own lifetime and nothing watches it.

**Effort:** M
**Priority:** P2
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

### Carry a jurisdiction's role through to output

**What:** Change `TransferFacts.jurisdictions` from `CountryCode[]` to a shape carrying the KB's
`role`, and render it. `merge/index.ts:161` is the single line that flattens it:
`vendor.processing.jurisdictions.map((j) => j.country)`.

**Why:** AWS renders as `processing: US, EEA, US, LU`, which reads as a deduplication bug and is
not one. `kb/vendors/aws.json` records US twice with distinct roles — Amazon Web Services, Inc. is
the contracting entity for customers outside EMEA and is *not* selected by the Region setting,
while the primary entry is. That distinction is exactly what the knowledge base exists to carry,
and the renderer throws it away, so the output invites a reader to "fix" it by deduplicating.
Deduplicating would destroy real information. `human.ts:108` already does
`[...new Set(finding.transfer.jurisdictions)]`, which is that mistake, shipped.

**Context:** The KB schema already requires `{country, role}` on every entry, so the data exists
and only the finding type discards it. Touches `packages/core/src/types.ts`,
`schemas/findings-1.1.0.json`, `merge/index.ts:161`, and five render sites —
`sarif.ts:90`, `sarif.ts:163`, `markdown.ts:34`, `markdown.ts:48`, `human.ts:106-109`.

The schema edit is only free until the first release: nothing has ever been published, so
`findings-1.1.0.json` can change in place today, and after a release a meaning change needs a new
schema file. That makes this cheaper now than it will ever be again.

Raised as T5.3 in `docs/reviews/2026-09-21-external-run-triage.md`, where it was recorded as
renderer-only. It is not — the engineering review caught that SARIF flattens it too, and the type
turns out to discard `role` before any renderer sees it.

**Effort:** M
**Priority:** P2
**Depends on:** None

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

## Testing

### Test the three shell scripts that still have none

**What:** Add vitest-driven tests for `skill/privacy-review/scripts/scan-transfers.sh`,
`skill/egressa/scripts/scan.sh` and `skill/egressa/scripts/reconcile-aws.sh`, reusing the
`execFileSync` pattern from `scripts/tracker-hook.test.ts:26`.

**Why:** T0.1 — every content gate reading false on any repository larger than a pipe buffer —
survived 18 test files because the only untested surface in the repository is bash. Fixing
`scope.sh` closes that instance; the other three scripts remain in the same unlit room.
`reconcile-aws.sh` is the single thing in the project that reaches the network, gated on
`EGRESSA_ALLOW_AWS=1`, and nothing asserts that gate holds.

**Context:** All 18 existing test files are TypeScript. `scripts/tracker-hook.test.ts` already
proves a non-TS artifact can be driven from vitest with `execFileSync` and a temp data dir, so
there is no harness to design. `scan-transfers.sh` is what the transfers specialist shells out
to, and per the revised dispatch contract the transfers specialist always runs — so a silent
failure there reproduces T0.1's exact shape in the one specialist nothing else gates. Highest
value single assertion: `reconcile-aws.sh` makes no network call without `EGRESSA_ALLOW_AWS=1`.
Raised by the engineering review in `docs/reviews/2026-09-21-external-run-triage.md`.

**Effort:** M
**Priority:** P2
**Depends on:** The `scope.sh` test harness (`scripts/scope-gates.test.ts`), which establishes
the fixture and helper shape these reuse.

## Completed

### Fix the wrong-host class in call-site analysis
**Completed:** v1-build (2026-09-10) — binding collection walked every declarator in the file into
one flat map keyed on the bare name, with no scope chain, so a `const` shadowed inside a function
resolved the outer call site to the wrong host at `high` confidence. Now module scope only, refusing
any name declared twice or reassigned. Four golden cases; the one documented *possibly wrong* answer
in the table was lifted deliberately in both the table and `docs/LIMITATIONS.md`.

### Read `aliases.clientConstructors` instead of ignoring it
**Completed:** v1-build (2026-09-10) — the field was in the vendor schema, typed in the loader,
authored in most entries, and read by nothing. It is where a *configured region* appears, so
`posthog.init(key, { api_host: 'https://eu.i.posthog.com' })` was a dependency signal only.
`callsites/sinks.ts` now derives sinks from it. Knowledge base sinks emit on a resolved host only,
so an API key in argument one is never reported as a destination, and `findSinks()` returns every
match rather than the first, because PostHog and Sentry both export `init`.

### Correct the Chapter V flag semantics
**Completed:** v1-build (2026-09-10) — `thirdCountryTransfer` was false on the adequate branch,
contradicting its own rule id: under Art 44 the transfer happens either way and Art 45 supplies its
basis. Added `additionalSafeguardsRequired` for the Art 46 question, and stopped setting
`adequacyDependent` for SCC vendors, where a decision existing for the country said nothing about
the vendor. Rule table v1.1.0; `docs/METHODOLOGY.md` updated.

### Fix the CLI entry point
**Completed:** v1-build (2026-09-10) — `egressa .` exited `Unknown command .`, every subcommand also
ran a spurious scan of its own name as a path, a nonexistent path produced a clean scan and exit 0,
and `.egressa.yml`'s `failOn` was declared and never read. argv is routed before citty sees it, so
the parent needs no fallback `run`.

### Close the stem gap in the claims contract
**Completed:** v1-build (2026-09-10) — the forbidden-word matcher took exact words, so "GDPR
violations: 3", "unlawfully" and "gdpr-violation-report" passed every surface check. Stems plus a
small inflection set, hyphens no longer a hiding place, and URLs stripped before matching so a
regulator decision filed under a slug ending "-illegal" stays citable. The knowledge base file list
in the contract is now computed rather than a hardcoded five ids.

### Scope the write-time hook's exemption to the storage key
**Completed:** v1-build (2026-09-10) — `STRICTLY_NECESSARY` was tested against the whole added text,
so a file importing `@clerk/nextjs` matched `auth` and silently suppressed a
`localStorage.setItem('utm_source', …)` beside it, which is the case the pattern exists to catch.
Now tested against the extracted key, with non-literal keys reported rather than cleared, and
server-set cookie APIs (`cookies().set`, `response.cookies.set`, Fastify, Hono) added.

### Write `pnpm kb:coverage`
**Completed:** v1-build (2026-09-10) — the command was documented in `CLAUDE.md` and wired in
`package.json`, and the script had never existed in git history. Also fixed the validator rejecting
any `lastVerified` written east of UTC, since it is a timezone-less date compared to a UTC instant.

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
