# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Egressa is a static analyzer that detects third-party data-egress patterns in JS/TS source and
reports their cross-border transfer exposure under GDPR Chapter V. pnpm workspace, TypeScript
ESM-only, Node >= 20.11.

The claim scope is load-bearing and is enforced by tests, not by convention:

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

## Commands

```bash
pnpm verify          # the gate: lint + typecheck + kb:validate + schema:check + test
pnpm test            # vitest run
pnpm test:watch
pnpm build           # tsup across all packages, then scripts/copy-kb.mjs
pnpm lint:fix        # biome check --write
pnpm kb:validate     # schema + source + collision checks over kb/
pnpm kb:coverage     # fraction of detected hosts/packages matching a KB entry
pnpm schema:check    # asserts types.ts, schemas/, and the disclaimer agree
```

Single test file or case:

```bash
pnpm vitest run packages/core/src/callsites/golden.test.ts
pnpm vitest run -t 'template literal'
```

There is no `pnpm ci` script — the name collides with a pnpm builtin. Use `pnpm verify`.

`vitest.config.ts` aliases `@egressa/core` and `@egressa/kb` to their **source**, so tests run
against edits without a build. Never add a build step before `pnpm test`.

Run the built CLI end to end with `node packages/cli/dist/cli.js scan fixtures/repos/<name>`.

## Architecture

One engine, several consumers. The real interface is the versioned findings schema, not the CLI.

```
packages/core       @egressa/core  — discovery, manifests, callsites, merge, exposure, output
packages/kb-loader  @egressa/kb    — loads and indexes kb/, ships the data
packages/cli        egressa        — the npx binary
packages/mcp        @egressa/mcp   — stdio MCP server
skill/egressa      Claude Code skill: transfer triage (shells out to the CLI, not to MCP)
skill/privacy-review Claude Code skill: consent, retention, logs, session replay, opt-out signals
kb/                 CC-BY-4.0 data, its own LICENSE
schemas/            published findings + vendor JSON Schemas
```

`scan()` in `packages/core/src/scan.ts` is pure in the ways that matter — no console, no network,
no `process.exit` — and returns a document rather than printing one. It does read files: the walk,
the manifests and the source reads all happen inside core. *Formatting* is what lives in the CLI. The MCP server validates arguments and shapes results and
contains zero analysis logic; behaviour changes go in core so all three surfaces get them at once.
`.egressa.yml` is an example: each surface loads it with core's `loadConfig`, so it can report a bad
file its own way, and `scan()` applies it. When only the CLI applied it, MCP silently dropped a
team's suppressions and excludes.

**Pipeline.** `discovery/walk.ts` (honours `.gitignore`/`.egressaignore`) → `manifests/` and
`callsites/` produce signals → `merge/` matches signals to KB entries and aggregates to one finding
per `(vendorId, ruleId)` with an `evidence[]` array → `exposure/rules.ts` derives flags from KB
facts → `output/sarif.ts` or the CLI formatters.

## Invariants that are easy to break

**Never read `node_modules`.** Scans are offline and must work on a fresh clone. Fixture repos ship
lockfiles only, which enforces this structurally.

**`jsonc-parser`, not `JSON.parse`, for manifests.** It yields source offsets (UTF-16 code units,
not bytes — SARIF distinguishes the two, and `LineIndex` converts them to lines over the same
string, so the pipeline is self-consistent). Without them every dependency finding degrades to a
file-level SARIF location and GitHub cannot render a line annotation.

**`oxc-parser`, not the TypeScript compiler API,** for call sites. The analysis is intraprocedural
constant folding; it must not require a resolved `Program` or installed packages.

**A wrong host is worse than no host.** `callsites/resolve-host.ts` resolves only when a delimiter
closes the authority inside a static chunk. Everything else emits `transfer/unresolved-egress`
naming the variable. Never add a heuristic that guesses.

The static chunk is the *folded* one: `leadingStatic()` in `callsites/index.ts` joins literals,
template chunks, `+` and stable module-scope strings before the authority is read, once. Reading it
from one operand alone is how `B + '.attacker.example/x'` resolved to the vendor `B` named, at high
confidence. The cost is that `BASE + path` with no delimiter in `BASE` is unresolved, deliberately.

The same rule governs *which binding* a name refers to. Binding collection has no scope chain, so
`callsites/index.ts` collects module-scope declarations only and refuses a name that is declared
twice or reassigned — a shadowed `const` otherwise resolved to the wrong host at `high` confidence.
"Declared" covers the binding forms `collectUnstableNames` lists, not just `const`: parameters
(destructured, defaulted, rest), `catch`, destructuring declarations, function, class and import
names, and TypeScript `enum`, `namespace` and `import X =`. "Reassigned" includes pattern
assignment, `for…in/of` targets, `++`/`--` and a `globalThis.X =` write, and a `with` statement or
direct `eval` anywhere makes every declared name unresolvable; type assertions and parentheses on a
target or on `eval` are seen through. A binding form missing from that list is a wrong-host bug, not
a recall gap: three successive reviews each found forms missing after the list was called complete.
Rebinding a classic script's global `var` through indirect `eval`, `new Function` or an aliased
`globalThis` is a documented boundary in `docs/LIMITATIONS.md`, not an oversight. When only declarators were counted,
`function f(B) { fetch(`${B}/v1`) }` resolved the module's `B`.
Building a real scope chain to recover that recall is not worth the failure mode it reintroduces.

**Client constructors come from the knowledge base, not a hardcoded table.**
`aliases.clientConstructors` names the option carrying the destination, and
`callsites/sinks.ts` turns those into sinks. This is where a *configured region* appears:
`posthog.init(key, { api_host: 'https://eu.i.posthog.com' })` is the only line in a repository that
says which PostHog cloud is in use. Two rules keep it safe — a knowledge base sink emits only on a
**resolved** host (so an API key in argument one is never reported as a destination), and
`findSinks()` returns every matching sink rather than the first, because two vendors both export
`init` and whichever sorted first used to silently shadow the other.

**A region is resolved from data, never from its prefix.** `kb/vendors/<id>.json` carries a
`regions[]` map with a citation per entry, and `exposure/regions.ts` matches it exactly. Three AWS
regions whose identifier begins `eu-` are outside the EEA — London is in the United Kingdom,
Zurich is in Switzerland — so a prefix rule would place both inside it at high confidence. The
validator deliberately has no "that looks wrong" check on the map either: the next contributor
would silence it by writing `IE`.

**Narrowing by region is opt-in per jurisdiction,** through `regionSelected`. The naive rule —
replace a vendor's jurisdictions with the region's country — deletes Supabase's Singapore
contracting entity and reports EU processing for a Singaporean processor on SCCs. A contracting
entity is not selected by a region setting, and neither is support access.

**A transfer to an adequate country is still a third-country transfer.** Art 44 is about where the
data goes; Art 45 supplies a basis for it. `thirdCountryTransfer` is therefore true on the adequate
branch, and `additionalSafeguardsRequired` carries the Art 46 question separately. `adequacyDependent`
means *this vendor moves if a decision is withdrawn*, so it is false for an SCC vendor.

**Severity and confidence are orthogonal.** Severity comes from KB facts; confidence from how the
signal was obtained. Both are surfaced; do not collapse them.

**A `reference` is not a `callsite`, and rendering it as one re-creates the defect it exists to
prevent.** `callsite` means data left here; `reference` means a vendor is named here, which is not
evidence that a call happened. `new URL()` and `new Request()` are reference sinks: constructing
either opens no socket, and the same expression appears in an HTTPS-redirect middleware parsing an
*inbound* request and in a DSN rewritten only to set a query parameter. They are demoted rather than
dropped because the vendor attribution can still be right — a `new URL()` on the line before a
`fetch` names the right vendor. Two rules follow. A reference sink emits only on a **resolved**
host, the same rule knowledge base sinks already follow, so an unresolved one is silent rather than
naming a variable. And confidence is capped at `medium`, as a ceiling and not a value: the certainty
is about the string, never about a transfer. `docs/LIMITATIONS.md` records the deliberate false
negatives this buys, and `scripts/check-schemas.ts` keeps `SIGNAL_KINDS` and the JSON enum in step —
it compares the kinds as well as the rule ids, because they were hand-synced past it once.

**Nothing defaults to `error`,** and SARIF must not set `security-severity` — that would file
privacy findings in GitHub's Security tab dressed as vulnerabilities. CI failure is expressed only
through `--fail-on` and exit codes (`0` clean, `1` findings, `2` usage, `3` internal, `4` KB load).
Default is `--fail-on none`.

**DPF is per-organisation, not country-level adequacy.** `exposure/rules.ts` gates the DPF decision
on `vendorIsDpfCertified()`. Treating it as blanket US adequacy clears every US vendor including
ones that rely on SCCs, which silently produces a clean scan on the case a user most needs flagged.
Do not "simplify" `covers()`.

**`euRegion` is not a boolean.** `scope: full | partial | product-specific` plus `docUrl` are
required when `available: true`. Every vendor in the KB that has one is partial in a different way.

**`normaliseHost()` deliberately does not strip `www.`** — the host trie treats it as a real label.

**A compiled `requirements.txt` is tested against real generator output, not hand-written cases.**
`manifests/python.ts` splits pip-compile and uv output into declared and transitive by its `# via`
annotations, and it broke in field tests 3 and 4 on shapes nobody had generated: uv's `# from`
index line read as a parent, and a plan to require an `-e .` line would have dropped every SDK from
`uv export` of a project that is not a package, which writes only `# via my-app`. The golden set in
`fixtures/lockfiles/requirements/` is uv's own output, regenerated offline by
`scripts/gen-compiled-requirements.sh` from stub wheels. Change the reader against those files, and
add a generator variant rather than a hand-written row when a new shape turns up.

**`.egressa.yml` is read strictly.** An unknown key, a YAML merge key, a non-mapping or non-UTF-8
file and a symlink that does not resolve are all `ConfigError`s. Each of them used to load as
something else or as no config, and the result was the same every time: a suppression the team
meant to be temporary became permanent, or one they wrote never applied, with nothing to say so. A
suppression that matches nothing is reported as a non-fatal scan error, qualified when the scan was
narrowed, because suppressions apply after the vendor and confidence filters.

## The two contracts enforced by tests

**`scripts/claims-contract.test.ts`** asserts the disclaimer from `packages/core/src/claims.ts`
reaches JSON, the SARIF driver, every rule's `help.markdown`, markdown, human output, the README,
`skill/egressa/SKILL.md` and the MCP source, and that no generated surface or KB entry contains a
forbidden claim word. If you reword user-facing output, run `pnpm test` before assuming it is fine.
The forbidden-word list lives in `claims.ts`. Entries there are **stems**, not exact words: the
matcher appends a small suffix set, because a list of exact words let "GDPR violations: 3" and
"unlawfully" through every surface check in the repository. The boundary class is letters and digits
only, so a hyphen cannot hide a stem either. URLs are stripped before matching — a citation's
address is the publisher's wording, and a knowledge base required to cite its sources has to be able
to link to a regulator decision filed under a slug ending "-illegal".

`references/language-rules.md` is the only file allowed to quote those words.

It also walks `skill/` and `kb/vendors/` and asserts every `SKILL.md` carries `NON_ASSESSMENT` and
no shipped markdown or knowledge base entry carries a forbidden word. **Both file lists are
computed, not hardcoded** — a hardcoded one would let the next specialist checklist or vendor entry
ship outside the contract just by nobody remembering to add it. Adding a file under `skill/`, or an
entry under `kb/vendors/`, therefore opts it in automatically, and the `language-rules.md` exemption
is itself asserted, so a file stops being exempt if it stops being the vocabulary table.

**`packages/core/src/callsites/golden.test.ts`** is a table of ~55 snippets → `{host|null, reason}`.
The `null` half is the important half: every entry in `docs/LIMITATIONS.md` has a corresponding
failing-by-design case. **A limitation starting to resolve is a test failure, not a win** — lift it
deliberately in both places or fix the regression.

Nothing in the table now records a *wrong* answer. The `let` reassignment case used to, and was
lifted deliberately in both places when scope handling landed; if a future change reintroduces one,
that is a regression rather than a documented limitation.

Tests do not pin the size of the knowledge base. Anything asserting "5 vendors" or a literal
`kb.version` fails on every entry added, for no reason connected to what it tests — read the roster
from `kb/` instead.

## The review skills

`skill/privacy-review/` is an orchestrator plus six specialist checklists, dispatched in parallel as
subagents. It covers what the engine does not: trackers firing before consent, personal data in logs,
session replay recording inputs, storage with no expiry, opt-out signals. `transfers.md` shells out
to the CLI rather than reimplementing detection by grep.

**`scope.sh` gates route work; they never assert.** Its three helpers must not depend on the
writer's exit status. They used to end in `grep -q`, which exits at its first match and closes the
pipe under the still-writing `printf`; the writer took SIGPIPE, `pipefail` promoted 141 to the
pipeline status, and every content gate read `false` — but only once the file list exceeded a pipe
buffer, so every fixture passed and every real repository failed, silently and closed. Three rules
came out of fixing it. A gate that could not be evaluated prints `SCOPE_DEGRADED: <GATE> exit=<n>`
beside its `false`, and `SKILL.md` dispatches that gate's specialist anyway, because a gate that did
not run is not a gate that came back false. A helper's status must be the *search's* own, which is
why `declared()` runs its search on its own line — `pipefail` reports the rightmost non-zero, so a
filter matching nothing (1) masks a real failure (2). And every file list is passed after `--`: the
reviewed tree is arbitrary third-party source, and a file named `-i.js` otherwise reaches `sed` as
its in-place flag and this read-only review rewrites what it was asked to read. For the same reason
every `git` call goes through `git_safe`, which disables `core.fsmonitor`, hooks, an external diff
and the pager: a repository handed over with its `.git` directory carries its own `.git/config`,
and git runs `core.fsmonitor` on every index refresh. A test asserts no bare `git` call remains.

Only the three inputs to `SIGNAL_TRACKERS_NO_CONSENT` strip comments before matching, because that
line is the one thing the script asserts rather than routes. Everything else matches raw text: a
needless route is cheap and a missed one is not. `scripts/scope-gates.test.ts` is the contract —
the first test of any shell script here, and its large-tree cases are generated rather than
committed, because a fixture small enough to commit is the reason the original bug survived.

Four rules govern it, and three of them exist because the research contradicted the obvious design:

**Findings carry a third axis: `decidability`.** `code` means the source settles it; `config` means
the code is consistent with several deployment realities; `undecidable` means no amount of source
reading answers it. **A `config` or `undecidable` finding must emit a `question`, never a `fix`.** A
remediation instruction attached to a question you cannot answer is how this produces a false
accusation, which is the same failure `resolve-host.ts` avoids by naming a variable instead of
guessing a host. A fourth value, `context`, carries neither: only the transfers specialist
uses it, for EU and adequate-country transfers, which are reported beside the findings rather than
as problems with a fix. The transfers specialist also ends with one `_scanner` JSON line accounting
for every scanner finding it emitted, merged or dropped, which Step 4 checks adds up; before it
existed, the only account of a dropped finding was prose that Step 4 discarded.

**Never emit a score.** `docs/ROADMAP.md` forbids a grade. gstack's `/review`, which this is modelled
on, ends with `PR Quality Score: X/10`; copying that would ship the exact number the project promised
not to. Counts only.

The contract is prose a model follows, so no test can run it. `scripts/skill-contract.test.ts` pins
the text instead: four decidability values, the `_scanner` line and its check, one citation rule in
every checklist, and no instruction to say something "in your summary" that has nowhere to go.
Whether specialists follow it is checked by field tests.

**`references/legal-basis.md` is the only place a provision or citation may come from.** It carries a
table of five widely repeated enforcement claims that failed verification, including a CNIL decision
number that does not exist. Two of them would otherwise have reached our output. Pass this file to
every specialist in full — a specialist that has not seen the table will cite from memory.

**The narrow checks are narrow on purpose.** Retention lost its general "no deletion path" check
because Prisma has no TTL construct, so there is no absence to test for. Session replay reduced to
one finding because seven of eight vendors already mask inputs by default; LogRocket's `inputSanitizer`
defaults to `false`. Consent gating must skip strictly-necessary cookies — session, CSRF, load
balancer — which is an exemption in Art 5(3) itself and the largest false-positive source in the set.

### The bundled CLI inside the skill

`pnpm skill:bundle` copies the built CLI and `kb/` into `skill/privacy-review/bin/`, so the
transfers specialist runs with no install. Layout is `bin/lib/egressa.mjs` beside `bin/kb/`, because
kb-loader resolves `../kb` from the JavaScript file — and the directory is `lib`, not `dist`, since
`.gitignore` excludes `dist/` everywhere and would silently drop the bundle.

It is a committed build artifact, so `scripts/skill-bundle.test.ts` fails loudly when its
`BUNDLE.json` tool or kb version drifts from source, naming the command that fixes it. Without that
the skill would keep reporting against an old knowledge base while looking current.

The bundle runs without the native parser and therefore usually reports `engine.degraded: true`
(manifest signals only). `scan-transfers.sh` prefers the build in the checkout the skill lives in
for that reason, and the specialist checklist requires the degraded state to be reported rather than
glossed.

**The reviewed repository is never executed.** Both scan scripts resolve every binary from their own
location, never from the scan target, and both `SKILL.md` files run scripts and read checklists from
`$SKILL_DIR` — the base directory the harness prints when a skill loads — never from the working
directory. The scripts used to walk up from the target and run the first `packages/cli/dist/cli.js`
they found, and the skills ran `bash skill/...` relative to the working directory, which is usually
the repository under review: either way a repository could commit code that a "read-only" review
then ran with the reviewer's credentials. The scripts also `cd` out of the target and drop
relative `PATH` entries before any `exec`, because npm reads a project `.npmrc` from the working
directory — a `registry=` line there would point the opt-in npx branch at an attacker's registry.
`scripts/untrusted-target.test.ts` plants all of these and asserts none of them runs.

## Plugin packaging

`.claude-plugin/plugin.json` makes the repository installable as a Claude Code plugin, and
`.claude-plugin/marketplace.json` makes it its own single-plugin marketplace. `skills: "./skill/"`
points at the existing directory rather than moving anything, and `hooks: "./hooks/hooks.json"`
registers the write-time hook. `claude plugin validate .` checks both manifests.

`hooks/tracker-write-check.mjs` is a `PreToolUse` hook on `Write|Edit|MultiEdit`. Four invariants,
all tested in `scripts/tracker-hook.test.ts` and the last also in the claims contract:

- **It never blocks.** No `permissionDecision` is ever emitted and it never exits 2, which is the
  only exit code that blocks a tool call.
- **It inspects only added text** — `content`, `new_string`, or each entry of `edits` — because an
  unchanged file is not a new decision.
- **It fires once per session, per file, per pattern**, keyed under `CLAUDE_PLUGIN_DATA`.
- **It exits 0 in silence on anything unexpected.** A hook that breaks an editing session is worse
  than one that misses something.

It skips test files, fixtures, non-code extensions, `skill/privacy-review/**` and any edit that
already contains a consent check, and it applies the Art 5(3) strict-necessity exemption to storage
writes. Those exclusions are the difference between a hook people keep and one they disable — and
disabling it disables the skills with it, since they ship in the same plugin.

It is written in Node rather than shell with `jq`, because Node is already required by everything
else here and `jq` is not guaranteed.

## Knowledge base

`kb/` is CC-BY-4.0 with its own LICENSE, deliberately separable from the Apache-2.0 code. Entries
state facts and cite them; nothing evaluative belongs in the data layer.

**A package alias may be a namespace, and an ambiguous one is refused.** An alias ending `/*` —
`@sentry/*` — matches the whole npm scope, which is registry-enforced: `@sentry/*` is Sentry by
construction, unlike `eu-*`, which is not the EEA by construction. The two look like the same
inference and are not. Exact aliases stay beside the wildcards because they carry `kind`, and
`merge/confidence.ts` lifts a direct dependency to `high` only for `official-sdk`; a namespace also
holds build plugins and test helpers, so a wildcard is `kind: scope` and falls through to `medium`.
`lookupPackage` tries exact first, then collects **every** matching scope and returns nothing when
two vendors both claim the name — the same refusal `findSinks()` makes, which the package index did
not have until a wildcard existed to expose it. `kb:validate` rejects the overlap in the data too,
naming the owning vendor, so the runtime branch should be unreachable on a shipped knowledge base.

Exposure is **computed, not authored** — `packages/core/src/exposure/rules.ts` is a versioned rule
table, and `kb/ratings/exposure-overrides.json` holds only overrides with mandatory rationale.
`kb/adequacy-status.json` is separate and EC-sourced, which is what makes
`--assume-adequacy-lapsed US:DPF` a one-line data change rather than a schema migration.

Entries are clean-room authored from vendor and regulator primary sources. `kb/PROVENANCE.md` lists
sources that must never be incorporated: Bearer Recipes (Elastic License v2); DuckDuckGo Tracker
Radar, Ghostery TrackerDB and Disconnect (all CC BY-NC-SA); the IAB TCF GVL. They may be cited in a
`sources` entry, never bulk-imported.

`kb/KB_POLICY.md` commits to marking an entry `disputed` on any good-faith objection before review
concludes. That is a product behaviour, surfaced by the CLI and SARIF, not just a policy note.

## Build notes

Builds use **tsup**, not tsdown (which failed on rolldown export mismatches and a missing peer).

`baseUrl`/`paths` live in the root `tsconfig.json` only — putting them in `tsconfig.base.json`
breaks tsup's DTS build with "not under rootDir 'src'".

`oxc-parser` must stay a direct dependency of `egressa` and `@egressa/mcp`, not just of core, or
the published binaries cannot resolve it. Note pnpm keeps it under `packages/cli/node_modules`, not
the workspace root, so anything running from elsewhere in the tree will not find it and will report
`engine.degraded`.

**The binary banner is load-bearing, for both binaries.** `tsup.banner.ts` at the root defines it
once, and `packages/cli/tsup.config.ts` and `packages/mcp/tsup.config.ts` both import it. It emits
the shebang *and* a `createRequire` shim, and neither `cli.ts` nor `server.ts` carries a shebang of
its own — a banner is written above the entry's first line, and a shebang only counts as the first
bytes of the file.

The `require` shim is there because both bundles inline `@egressa/core`, and through it CommonJS
(`yaml`, and `citty` in the CLI) that calls `require()` at run time. esbuild rewrites those to a
`__require` shim whose first branch is `typeof require !== "undefined" ? require : <throw>`; in an
ESM bundle nothing defines it, so the binary threw `Dynamic require of "process" is not supported`
the moment it ran outside a `node_modules` tree. Defining `require` above the shim is the supported
fix. The MCP server shipped without it once, because its config assumed the banner carried only the
shebang — which is why there is now one definition rather than two.

**`pnpm build` ends by booting both binaries.** `scripts/smoke-dist.mjs` runs `egressa --version`,
connects an MCP client to `egressa-mcp`, and has each one scan a two-file repository. It fails the
build unless both scans ran with the native parser (`engine.degraded` false, a call-site finding
present) and loaded the knowledge base shipped beside that binary. Starting alone proves neither. Nothing in
`pnpm test` can catch a bundle that does not boot, since vitest aliases every package to source.
The script resolves the MCP SDK from the package beside the binary, never by bare import: from
`scripts/` a bare import finds whatever copy sits in a parent directory, or none on a fresh clone.
`pnpm smoke:pack` runs the same check against the packed tarballs installed in a clean
`node:20-slim` container. It needs Docker and the network, so it is manual and not in CI.

`splitting: false` on the CLI, because the dynamic `import('oxc-parser')` gave tsup a split point
and the emitted chunks broke any consumer that copies `cli.js` alone.

**`oxc-parser` is loaded with a guarded top-level `await import()`,** never a static import. It is a
native addon and fails on a platform with no prebuild; a static ESM import cannot be caught, because
the failure arrives as a `SyntaxError` at link time before any code runs. `parserAvailable()` in
`packages/core/src/callsites/index.ts` is the seam, `scan()` turns it into `engine.degraded`, and
`packages/core/src/degraded.test.ts` forces the failure. Do not convert it back to a static import.

## Current state

v1 is complete on branch `v1-build` and **unpublished** — nothing on npm, no git remote. The
release pipeline does not exist yet: no `.changeset`, no `.npmrc`, no release workflow.

Because nothing has ever been published, `schemas/findings-1.0.0.json` was corrected in place when
the Chapter V flag semantics were fixed, rather than a 2.0.0 being cut for a version no consumer
has. That option closes at the first release; after it, a meaning change needs a new schema file.

The knowledge base holds 17 vendors. `pnpm kb:coverage` reports the matched fraction over the
fixture repositories — note that the package denominator counts every declared dependency including
frameworks and build tools, so that figure is a floor rather than an accuracy measure.

`docs/designs/publish-first-linter-wedge.md` is the approved design record: corrected ICP, the
"complementary not better" claim about code-based vendor discovery, why the sub-processor register
framing was rejected, and the ordered publish steps. Read it before proposing product direction.

`TODOS.md` tracks actionable engineering work, and is deliberately not the roadmap: the roadmap
records product scope decisions, `TODOS.md` records work someone could pick up. The P0 there is that
no git remote exists, so every documented plugin install path currently resolves to nothing.

`docs/ROADMAP.md` records what v1 deliberately excludes (Python call sites, cross-module constants, HTML
`<script src>`, tag managers, PII data-flow) and what is not planned at all. Infrastructure as code
has moved out of that list: `packages/core/src/infrastructure/` reads Terraform, Serverless and
Vercel configuration for the regions a repository declares.

`skill/egressa/scripts/reconcile-aws.sh` is the only thing in the project that reaches the network
during an ordinary run. It is opt-in through `EGRESSA_ALLOW_AWS=1`, read-only, never invoked by a
scan, and emits region strings only — resolving one to a country stays the knowledge base's job.
The claims contract now walks `skill/**/*.sh` as well as the markdown, because a script used to
ship with no claim-scope enforcement at all.
