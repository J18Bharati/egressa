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

`scan()` in `packages/core/src/scan.ts` is pure — no console, no network, no `process.exit`. All
I/O and formatting live in the CLI. The MCP server validates arguments and shapes results and
contains zero analysis logic; behaviour changes go in core so all three surfaces get them at once.

**Pipeline.** `discovery/walk.ts` (honours `.gitignore`/`.egressaignore`) → `manifests/` and
`callsites/` produce signals → `merge/` matches signals to KB entries and aggregates to one finding
per `(vendorId, ruleId)` with an `evidence[]` array → `exposure/rules.ts` derives flags from KB
facts → `output/sarif.ts` or the CLI formatters.

## Invariants that are easy to break

**Never read `node_modules`.** Scans are offline and must work on a fresh clone. Fixture repos ship
lockfiles only, which enforces this structurally.

**`jsonc-parser`, not `JSON.parse`, for manifests.** It yields byte offsets. Without them every
dependency finding degrades to a file-level SARIF location and GitHub cannot render a line
annotation.

**`oxc-parser`, not the TypeScript compiler API,** for call sites. The analysis is intraprocedural
constant folding; it must not require a resolved `Program` or installed packages.

**A wrong host is worse than no host.** `callsites/resolve-host.ts` resolves only when a delimiter
closes the authority inside a static chunk. Everything else emits `transfer/unresolved-egress`
naming the variable. Never add a heuristic that guesses.

**Severity and confidence are orthogonal.** Severity comes from KB facts; confidence from how the
signal was obtained. Both are surfaced; do not collapse them.

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

## The two contracts enforced by tests

**`scripts/claims-contract.test.ts`** asserts the disclaimer from `packages/core/src/claims.ts`
reaches JSON, the SARIF driver, every rule's `help.markdown`, markdown, human output, the README,
`skill/egressa/SKILL.md` and the MCP source, and that no generated surface or KB entry contains a
forbidden claim word. If you reword user-facing output, run `pnpm test` before assuming it is fine.
The forbidden-word list lives in `claims.ts`; `references/language-rules.md` is the only file
allowed to quote those words.

It also walks `skill/` and asserts every `SKILL.md` carries `NON_ASSESSMENT` and no shipped markdown
carries a forbidden word. **The file list is computed, not hardcoded** — a hardcoded one would let
the next specialist checklist ship outside the contract just by nobody remembering to add it. Adding
a file under `skill/` therefore opts it in automatically, and the `language-rules.md` exemption is
itself asserted, so a file stops being exempt if it stops being the vocabulary table.

**`packages/core/src/callsites/golden.test.ts`** is a table of ~45 snippets → `{host|null, reason}`.
The `null` half is the important half: every entry in `docs/LIMITATIONS.md` has a corresponding
failing-by-design case. **A limitation starting to resolve is a test failure, not a win** — lift it
deliberately in both places or fix the regression.

## The review skills

`skill/privacy-review/` is an orchestrator plus six specialist checklists, dispatched in parallel as
subagents. It covers what the engine does not: trackers firing before consent, personal data in logs,
session replay recording inputs, storage with no expiry, opt-out signals. `transfers.md` shells out
to the CLI rather than reimplementing detection by grep.

Four rules govern it, and three of them exist because the research contradicted the obvious design:

**Findings carry a third axis: `decidability`.** `code` means the source settles it; `config` means
the code is consistent with several deployment realities; `undecidable` means no amount of source
reading answers it. **A `config` or `undecidable` finding must emit a `question`, never a `fix`.** A
remediation instruction attached to a question you cannot answer is how this produces a false
accusation, which is the same failure `resolve-host.ts` avoids by naming a variable instead of
guessing a host.

**Never emit a score.** `docs/ROADMAP.md` forbids a grade. gstack's `/review`, which this is modelled
on, ends with `PR Quality Score: X/10`; copying that would ship the exact number the project promised
not to. Counts only.

**`references/legal-basis.md` is the only place a provision or citation may come from.** It carries a
table of five widely repeated enforcement claims that failed verification, including a CNIL decision
number that does not exist. Two of them would otherwise have reached our output. Pass this file to
every specialist in full — a specialist that has not seen the table will cite from memory.

**The narrow checks are narrow on purpose.** Retention lost its general "no deletion path" check
because Prisma has no TTL construct, so there is no absence to test for. Session replay reduced to
one finding because five of six vendors already mask inputs by default; LogRocket's `inputSanitizer`
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
(manifest signals only). `scan-transfers.sh` prefers a real repo build for that reason, and the
specialist checklist requires the degraded state to be reported rather than glossed.

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

**The CLI banner is load-bearing.** `packages/cli/tsup.config.ts` emits the shebang *and* a
`createRequire` shim, and `cli.ts` no longer carries a shebang of its own — a banner is written
above the entry's first line, and a shebang only counts as the first bytes of the file.

The `require` shim is there because `citty` and `yaml` are inlined (`noExternal`), and the CommonJS
inside them calls `require()` at run time. esbuild rewrites those to a `__require` shim whose first
branch is `typeof require !== "undefined" ? require : <throw>`; in an ESM bundle nothing defines it,
so the binary threw `Dynamic require of "process" is not supported` the moment it ran outside a
`node_modules` tree. Defining `require` above the shim is the supported fix.

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

`docs/designs/publish-first-linter-wedge.md` is the approved design record: corrected ICP, the
"complementary not better" claim about code-based vendor discovery, why the sub-processor register
framing was rejected, and the ordered publish steps. Read it before proposing product direction.

`docs/ROADMAP.md` records what v1 deliberately excludes (Python, cross-module constants, HTML
`<script src>`, tag managers, IaC, PII data-flow) and what is not planned at all.
