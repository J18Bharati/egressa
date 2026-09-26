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

### Decide what belongs in a vendor's default jurisdiction set

**What:** Write down a convention for which jurisdictions a vendor entry lists as default
processing, as opposed to regions a customer has to select, and re-author Twilio against it.

**Why:** Twilio lists US, IE and AU, all `primary` with no `regionSelected`, although its own notes say
US1 is the default and IE1 and AU1 are chosen by the customer. AWS lists only what a default customer
reaches. Under Twilio's convention AWS would be a `warning`; under AWS's, Twilio would be a `note`. The
first `warning` on a real repository (field test 3) rests on `decision:AU:none`, for a client that sets
no region at all. That is A12 in `docs/reviews/2026-09-26-field-test-3-triage.md`.

**Context:** `regionSelected` matters only once a region is detected (`exposure/rules.ts:92`), so
marking AU selectable does not change the default set alone. The convention belongs in
`kb/KB_POLICY.md`, and every entry with more than one `primary` country needs checking against it.

**Effort:** S
**Priority:** P2
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

### Decide whether the review should check objection and direct-marketing opt-outs

**What:** Decide whether privacy-review gets a checklist for honouring an objection or an
unsubscribe: an `opt_out` or `stop_contacting` state that is recorded but never acted on, and
outreach to people who never signed up. If yes, add the provisions to
`references/legal-basis.md` first.

**Why:** In the 2026-09-25 field test, an ad-hoc dispatch outside the skill's routing returned three
substantive findings of this kind against a backend that emails debtors. One was an `opt_out`
auto-action that no code path executes. No shipped checklist covers this. `opt-out-signals.md` is
about GPC and similar signals owed by a business that sells or shares data, and it correctly stays
silent without advertising trackers. The findings cited Art 21(1), which `legal-basis.md` does not
carry. Under this skill's rules, nothing may be cited until it does.

**Context:** F2 in `docs/reviews/2026-09-25-live-run-triage.md`. The triage first recommended
routing `opt-out-signals.md` on `SCOPE_OPT_OUT`. That was wrong, because the checklist's own scope
rule would then emit nothing. `SCOPE_OPT_OUT` is now documented as a context gate, and
`scope-gates.test.ts` fails on any gate that is neither routed nor listed as context. A new
checklist is a product-scope decision, so record it in `docs/ROADMAP.md` too. It also needs the
cold-context validation the other specialists had.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Decide whether replay inside a general SDK needs consent routing

**What:** Decide whether Sentry and Datadog replay terms should also feed `SCOPE_TRACKER_CODE`, and
so the consent-gating dispatch and possibly `SIGNAL_TRACKERS_NO_CONSENT`, and whether
`specialists/consent-gating.md` should name them.

**Why:** Since the 2026-09-25 fixes, `Sentry.replayIntegration()` routes the session-replay
specialist, which checks masking. An app whose only recorder is Sentry Replay still gets no
consent-gating dispatch, because the tracker gates do not know it. Whether a replay recorder
needs prior consent is not a masking question.

**Context:** Raised by the branch review of `field-test-2-fixes` (finding 11). Be careful with
`SIGNAL_TRACKERS_NO_CONSENT`: it is the one line `scope.sh` *asserts* rather than routes, and it
strips comments for that reason. Widening it changes what the script claims, not only what it
routes. Needs a citation from `references/legal-basis.md` before any checklist wording.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Assert one structured block per dispatched specialist

**What:** Step 4 of `SKILL.md` names every dispatched specialist that returned no structured block,
and reports that specialist's lane as not reviewed rather than as silent.

**Why:** In the 2026-09-21 run, one specialist's output was lost entirely and the result read as a
clean lane. It did not recur on 2026-09-25, where six of six returned blocks, but one clean run
does not show the failure is impossible.

**Context:** T16 in `docs/reviews/2026-09-21-external-run-triage.md`. It was accepted there and
never tracked here.

The transfers specialist needs a count as well (F6 in `docs/reviews/2026-09-26-field-test-3-triage.md`).
In that run it mapped 7 of 9 scanner findings, and the Step 3 no-commentary rule gave it no way to say
so. Have `transfers.md` emit one structured line such as
`{"_scanner":{"findings":9,"emitted":7,"dropped":[…]}}`, and have Step 4 check
`emitted + dropped == findings`.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Let two specialists' findings on one line be seen to agree

**What:** Change the fingerprint so the Step 4 merge can recognise the same `file:line` raised by
different specialists, and mark those as corroborated rather than deduplicating one away.

**Why:** The scheme appends the category (`file:line:consent`, `file:line:pii-in-logs`), so two
specialists flagging the same line never collide. The 2026-09-25 run produced a concrete pair on a
Sentry config line. Agreement between independent checklists is the strongest signal the skill can
produce, and the merge cannot see it.

**Context:** T4.1 in the 2026-09-21 triage and F4 in the 2026-09-25 triage. Keep category in the
record. Only the join key changes.

**Effort:** S
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

The same change should carry the **evaluated** jurisdiction set (A11 in
`docs/reviews/2026-09-26-field-test-3-triage.md`). `transfer.jurisdictions` is never narrowed by a
region. Only `exposure.inputs` records `narrowedTo:`, which `human.ts` string-parses back out. So in
markdown and SARIF, a `us-east-2` finding reads identically to the vendor default, including "EEA",
and the `[unmapped]` marker exists only in human output. Add the evaluated set and the region to the
finding, and render both in all four formats. While in those messages, replace "N references in this
repository" with "N evidence entries" (E15), since `reference` is now a signal kind meaning "named, not
called".

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

### Let `unmatched` be filtered

**What:** Apply `--min-confidence` to `unmatched`, or add `--no-unmatched` / `--only-unmatched`.

**Why:** `--min-confidence high` cut findings from 13 to 5 on the 2026-09-25 target and left all 63
packages and 5 hosts in place. About 85% of them are build tooling or first-party packages. The block
is the only recall signal the project has, and it is being scrolled past.

**Context:** T17 in the 2026-09-21 triage, never tracked. `human.ts` and `markdown.ts` print it
unconditionally.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Read regions from `docker-compose.yml`

**What:** Read literal region values from `environment:` in compose files, as `fly.toml`'s
`primary_region` is read today.

**Why:** `SCOPE_IAC` in the privacy-review skill routes on `docker-compose.ya?ml$`, and the engine
reads nothing from those files. On the 2026-09-25 target, nine `eu-west-1` literals in a production
compose file were invisible to the scan while the skill reported infrastructure present.

**Context:** B9 in the 2026-09-25 triage. `infrastructure/key-literal.ts` is most of a reader. The
open question is which keys count (`AWS_REGION`, `AWS_DEFAULT_REGION`, `awslogs-region`) and which
vendor each attributes to. Attribute only where the key names the vendor. Guessing would violate
"a wrong host is worse than no host".

**Effort:** M
**Priority:** P2
**Depends on:** None

### Count what ignore files removed

**What:** Record in all four formats a count of paths excluded by `.gitignore` / `.egressaignore`.
Record the count, not the globs.

**Why:** `scan.exclude` records `--exclude` and `.egressa.yml` so a narrowed SARIF says it is
narrowed. Ignore files narrow the scan just as much and leave no trace. The rationale at
`packages/core/src/types.ts:285`, "already committed and readable", does not hold for a SARIF that
travels without the repository.

**Context:** E10 in the 2026-09-25 triage. It touches the findings schema, which is free to change
in place until the first release.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Name Terraform's GCP and Azure providers correctly

**What:** `infrastructure/index.ts:50` loops over `['aws', 'gcp', 'azure']`. Terraform calls them
`google` and `azurerm`, and Azure's key is `location`, not `region`.

**Why:** Two-thirds of the loop can never match.

**Context:** C4 in the 2026-09-25 triage. There are no GCP or Azure knowledge base entries, so
nothing is lost today. Do this together with those entries, or drop the two names until they
exist.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Locate the Serverless region by its YAML key range

**What:** In `parseServerlessYaml`, take the annotation position from the `region` pair's key range
in the parsed document, not from `text.indexOf('region', text.indexOf('provider'))`
(`packages/core/src/infrastructure/index.ts:113`).

**Why:** The region *value* comes from the YAML parser and is correct. Only the reported location is
found by substring, so `profile: region-admin` placed above `region: eu-west-1` puts the SARIF
annotation on the profile line. This is the same substring class as the Terraform reader's
`sts_region` defect, fixed in `key-literal.ts`, but here only the location is affected.

**Context:** The document is already parsed with `keepSourceTokens`. The only fixture is
`regional-multi/serverless.yml`. Add a case where a `region-` value comes before the key. Found
by the engineering review of the 2026-09-25 fixes (R8).

**Effort:** S
**Priority:** P3
**Depends on:** None

### Escape control characters from the scanned repository in output

**What:** Escape C0/C1 control characters in every string the human and markdown formatters take
from the scanned tree (regions, snippets, `matchedOn`, file names), or reject a region literal that
is not `^[A-Za-z0-9_.-]{1,64}$` at read time.

**Why:** The reviewed repository is arbitrary third-party source. A `main.tf` with ESC or BEL
inside `region = "…"` puts terminal escape sequences into human output. The branch review's
security pass reproduced this with `od -c`. The same stance already governs `scope.sh`: a file named
`-i.js` must not become an option.

**Context:** Found by the branch review of `field-test-2-fixes` (finding 7). The issue predates
that branch, but the branch edited the render path. SARIF and JSON escape by construction.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Finish the Python surface: lookups, `unmatched`, constraints

**What:** Four gaps left by the manifest reader, found by the branch review of
`cli-and-routing-fixes`:
- `egressa vendors show boto3` and MCP `lookup_vendor` look up npm only, and MCP `check_package`
  does not normalise a pypi name.
- `unmatched.packages` is one set across ecosystems, so an npm and a pypi package with the same
  name are indistinguishable.
- A file referenced by `-c` from a requirements file pins versions and installs nothing. Only
  `constraints*.txt` is skipped by name today.
- The `kb:validate` pypi rule has no negative test, and it re-implements `normalisePypiName`.

Field test 3 (`docs/reviews/2026-09-26-field-test-3-triage.md`, A13 and B11) added:
- `requirements-constraints.txt` is read, because `isRequirementsFile` checks only a `constraints`
  prefix. Fix this one first: it is the only precision item here.
- A wheel filename (`twilio-9.0.0-py3-none-any.whl`) and a name split by `\` continuation both reach
  `unmatched` mangled. pip joins continuation lines before parsing, and so should the reader. It
  should also refuse a token ending in an archive suffix.
- A full-line comment ending in `\` is continued by the reader, but pip does not continue it.
- Unread equivalent spellings: `optional-dependencies` as an inline table or a dotted key under
  `[project]`, `[tool.poetry.dependencies.<name>]` sub-tables, `dependencies = {…}` under
  `[tool.poetry]`, `dev-requirements.txt`/`test-requirements.txt`, and Fly's single-quoted
  `primary_region`.

**Why:** `docs/LIMITATIONS.md` now points a user at `unmatched` for missing Python aliases, and
the lookup commands are how they would check one.

**Context:** Keying `unmatched` by ecosystem changes the findings schema. That is free before the
first release and needs a new schema file after it.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Refuse a manifest reached through a symlink out of the scan root

**What:** Skip any discovered manifest whose real path is outside the root.

**Why:** `manifests/index.ts` reads whatever path discovery returns, and a symlink in a reviewed
repository can point anywhere on the machine. The problem predates the Python reader, but the new
patterns widen it. The security pass reproduced it.

**Context:** Branch review of `cli-and-routing-fixes`. `egressa schema` also resolves `schemas/`
against the working directory rather than the package, which is the same class of assumption.

**Effort:** S
**Priority:** P2
**Depends on:** None

### Validate a knowledge base passed with `--kb`

**What:** Run the `kb:validate` checks at load time for a user-supplied `--kb`. At minimum, run the
namespace-overlap and alias-kind checks.

**Why:** The 2026-09-25 run loaded a hand-built knowledge base with overlapping namespaces, and it
exited `0`. The shipped knowledge base passes every guard in the authoring pipeline. A supplied one
skips all of them, which leaves the runtime ambiguity branch as the only defence.

**Context:** The exit code for a knowledge base that fails to load is already `4`.

**Effort:** S
**Priority:** P3
**Depends on:** None

### `--full` and `--group-by`

**What:** `--full` to disable `... and N more` truncation, and `--group-by file|service|vendor`.

**Why:** Truncation hid the only structurally distinct call site in the 2026-09-21 run. "What does
this service send?" can be answered only from the JSON today.

**Context:** T19 and T20 in the 2026-09-21 triage, never tracked. Absence was reconfirmed from
`--help` on 2026-09-25.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Detect a stale skill bundle by content, not only by version

**What:** Record a content hash of `bin/lib/egressa.mjs`'s source build in `BUNDLE.json`, and have
`scripts/skill-bundle.test.ts` compare it with a fresh build's. Alternatively, move `VERSION` to a
prerelease while `[Unreleased]` holds engine changes.

**Why:** The drift test compares `toolVersion` and `kbVersion` only. An engine change made at
the same version, which is every change between releases, leaves the bundle reporting the old
behaviour while the test stays green. The bundle is current today only because it was rebuilt by
hand.

**Context:** Branch review of `field-test-2-fixes`, finding 13. A hash of the built file couples
the test to a build, which `pnpm test` must not require. Hashing the inputs (core sources plus
the tsup config) avoids that.

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
test from a clean container, since the bundle's shape has changed twice. `pnpm smoke:pack` now does that
for all four tarballs installed together in `node:20-slim`, by running `scripts/smoke-dist.mjs`
against the installed binaries. Wire it into the release workflow rather than writing a second
check. It installs all four because `egressa` and `@egressa/mcp` declare `@egressa/core` and
`@egressa/kb` as runtime dependencies although tsup bundles them, so a tarball published alone
would try to fetch packages that do not exist on the registry. Decide that before the first
publish.

**Effort:** M
**Priority:** P2
**Depends on:** Create the GitHub repository and push

### Make `smoke:pack` pull its image

**What:** Pass `--pull=always` to the `docker run` in `scripts/smoke-pack.mjs`, or print the image
digest on the `ok` line.

**Why:** Field test 3 ran it against a cached `node:20-slim` five months old. A "clean container" check
that uses whatever image happens to be cached is not testing a current Node 20, and the pull path was
never exercised. That is G4 in `docs/reviews/2026-09-26-field-test-3-triage.md`.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Testing

### Teach the transfers specialist that a reference is not a call

**What:** Add a rule to `skill/privacy-review/specialists/transfers.md`: a finding whose evidence
contains no `kind: "callsite"` entry is at most `decidability: "config"` and must emit a `question`,
never a `fix`, whatever its rule id — and must say "named, not called" in its summary. Mirror it in
`references/finding-schema.md` and in `skill/egressa/references/interpreting-findings.md`, which
still describes confidence without mentioning the kind axis.

**Why:** The `reference` kind does not survive the CLI-to-skill boundary, and the skill converts it
back into an accusation. `transfers.md` derives `decidability` from `ruleId` alone —
"`transfer/third-country-egress` → `code`. The vendor and its jurisdiction are both settled facts" —
and its mapping table reads only `ruleId`, `severity`, `confidence` and `evidence[0]`. But a
reference-only finding carries exactly those rule ids: `const u = new URL('https://api.stripe.com/v1')`
alone produces `transfer/adequate-country-egress` with `evidence: [{kind: "reference"}]`. The
specialist therefore emits `decidability: "code"`, which under the skill's own rule licenses a
remediation instruction for `new URL(request.url)` in redirect middleware or a rewritten database
DSN. That is the precise false accusation the kind was introduced to prevent.

**Context:** `packages/core/src/types.ts` states "Consumers must not render a `reference` as though
it were a `callsite`", and the largest downstream consumer was not updated. `scan-transfers.sh`
already runs `--format json`, so `evidence[].kind` is in the data the specialist reads — this is a
checklist change, not a plumbing one. Raised by the red team during the `/review` pass on
`gate-layer-fixes`; the engine-side and renderer-side halves were fixed there, this half was
deferred. `scripts/claims-contract.test.ts` covers the file, so the wording must stay inside the
claim scope.

**Effort:** S
**Priority:** P1
**Depends on:** None

### Carry the reviewed file list NUL-delimited end to end

**What:** Build the file list in `skill/privacy-review/scripts/scope.sh` with `git ls-files -z` /
`find -print0` and filter it NUL-aware (`grep -z`, `read -r -d ''`), instead of joining it with
newlines and converting with `tr '\n' '\0'` just before `xargs -0`.

**Why:** The `-0` is only nominally end to end. The list is newline-separated from line 61 and is
filtered by newline-oriented `grep`, `sed` and `while IFS= read -r f` before being re-delimited, so
a filename containing a newline is already split into two fragments by the time NUL delimiting
starts. Both halves then fail the `[ -f "$f" ]` existence check and are dropped. The result is
silent under-review: a file can remove itself from the scan by its own name. Not injection — the
`--` terminators added alongside this item close that — but it defeats the coverage the gates claim,
and silence is the failure mode this script has already been bitten by twice.

**Context:** Pre-existing; identical on `v1-build`, so not a regression from the gate work. Raised
by the security specialist during the `/review` pass on `gate-layer-fixes` and deliberately deferred
there: it touches the whole front half of the script, including the `SELF_EXCLUDED` and `EXISTING`
derivations, and risks regressing the gates that pass now. `scripts/scope-gates.test.ts` gives it a
harness that did not exist before, including hostile-filename cases to extend. Minimum bar for
calling it done: a fixture whose filename contains a newline is either reviewed or reported, never
dropped in silence.

**Effort:** M
**Priority:** P2
**Depends on:** None

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

While there, make `scan-transfers.sh` print which binary tier it resolved. The binaries are the
target's build, the repository the skill lives in, and the degraded bundle. On 2026-09-25 it
resolved through the skill's own checkout, a tier that an installed copy does not have, and nothing
in the output said so (F3 in `docs/reviews/2026-09-25-live-run-triage.md`).

**Effort:** M
**Priority:** P2
**Depends on:** The `scope.sh` test harness (`scripts/scope-gates.test.ts`), which establishes
the fixture and helper shape these reuse.

## Completed

### Read Python dependency manifests
**Completed:** cli-and-routing-fixes (2026-09-26) -- `packages/core/src/manifests/python.ts` reads
`requirements*.txt` and `pyproject.toml` (PEP 621, PEP 735, Poetry), with `pypi` aliases for Twilio
and AWS and a `kb:validate` rule that keeps them PEP 503 normalised. On the field-test target Twilio
is now reported where it was missed. Python call sites and lockfiles remain on the roadmap. Other
vendors' Python SDKs need their own `pypi` aliases, each checked against its publisher.

### Reject a flag the CLI cannot honour
**Completed:** cli-and-routing-fixes (2026-09-26) -- `packages/cli/src/flags.ts` checks every flag
against the matched command's declared `args` before citty runs, and an unknown one exits `2` with
its name. It accepts both spellings, `--no-` negation, aliases, `--name=value`, and a string flag's
value even when that value starts with `-`. A negated `exclude` glob, from the flag or from
`.egressa.yml`, now exits `2` too. Every flag the skills, docs and action pass was checked against
the declarations first.

### Start a CHANGELOG
**Completed:** gate-layer-fixes (2026-09-22) -- written at 0.2.0 rather than waiting for the first
tag, because the branch that prompted it changed both halves at once and the reasoning would not
have survived to a later release. Engine and knowledge base are listed separately, as the item
asked. `VERSION` at the repository root became the single source of the tool version in the same
change: it had been written out in five places and two had already drifted to 0.0.0, with the MCP
server carrying its own literal and `version.ts` claiming a build-time stamp that never happened.
`scripts/version-consistency.test.ts` is what makes the single source real.

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
