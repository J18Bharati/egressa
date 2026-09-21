# Changelog

Notable changes to Egressa. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

**Engine and knowledge base are listed separately on purpose.** The knowledge base is versioned
data that consumers pin and diff, and a knowledge base update can change what a scan reports with
no code moving at all. A reader working out why today's findings differ from last week's needs to
know which half moved. Knowledge base versions are dates (`kb.version`); the tool version is semver.

Nothing has been published yet — there is no npm release and no git remote — so every version below
describes the state of the repository rather than an artifact anyone can install.

## [0.2.0] — 2026-09-22

Knowledge base `2026.09.21`. Findings schema `1.1.0`.

### Added

- **`--exclude <glob>` on `scan`**, repeatable, unioned with `exclude:` in `.egressa.yml` rather
  than replacing it. `.egressaignore` and `.gitignore` were already honoured; all four mechanisms
  are now documented together in the README and in `--help`. The exclusion machinery existed and
  was reachable only from a config file, which is why an external reviewer could not find it.
- **The applied exclusion list is recorded in output** — `scan.exclude` in JSON, `runs[].properties`
  in SARIF, and a count in the human and markdown footers. A narrowed scan now says so. Without it
  a SARIF produced with `--exclude 'src/**'` was indistinguishable from one over a clean repository.
- **A `reference` signal kind.** `callsite` means data left here; `reference` means a vendor is
  named here, which is not evidence that a call happened. `new URL()` and `new Request()` emit it,
  capped at `medium` confidence, and only on a resolved host. Marked distinctly in human, markdown
  and SARIF output, and carried through the MCP summary as `referenceOnly`.
- **Namespace package aliases.** A knowledge base alias may end `/*` and claim a whole registry
  scope. Where two vendors' namespaces both match a name, nothing is attributed.
- **`exclude` on the MCP `scan_repository` tool**, matching the CLI.
- `VERSION` at the repository root as the single source of the tool version, with
  `scripts/version-consistency.test.ts` asserting every copy agrees with it.
- `scripts/scope-gates.test.ts` — the first tests for any shell script in this repository.

### Fixed

- **The privacy review's scope gates returned `false` on any large repository.** Every gate helper
  ended in `grep -q`, which exits at its first match and closes the pipe under the still-writing
  file list; the writer took SIGPIPE and `pipefail` promoted it to the pipeline status. The script
  still printed a well-formed block, so a repository full of things to look at reported nothing and
  said nothing about why. Five of six specialists never ran. Invisible to the suite because every
  fixture was smaller than a pipe buffer.
- **A reviewed filename could be read as an option.** A file named `-i.js` reached `sed` as its
  in-place flag and the read-only review rewrote the files it was asked to read; a file named
  `--regexp=^|z.js` reached `grep` as a pattern and turned every content gate true.
- **`scope.sh --base` with no value looped forever**, printing nothing at all.
- **A gate that fails now says so** — `SCOPE_DEGRADED: <GATE> exit=<n>` beside its `false`, and the
  skill dispatches that gate's specialist anyway. A gate that could not be evaluated is not a gate
  that came back false.
- **The tracker conjunction no longer fires on commented-out code**, including a `//` comment inside
  a `<script>` block in an HTML file, which is how a tracker snippet is actually left behind.
- **Generated output is no longer read as evidence.** `.nuxt`, `.output` and their siblings are
  excluded from both the file set and the manifest search; a framework build directory carries the
  vendors a project *could* wire up, not the ones it did.
- **A constructed URL that a call consumes is a call site again.** `fetch(new URL(x).toString())`,
  `fetch(u.toString())` and `fetch(req)` through a module-scope binding all resolve at `high` and
  report once, rather than being demoted and — in two shapes — reported twice.
- **`lookupPackage` no longer returns the first matching namespace**, which would have attributed a
  package to whichever vendor sorted first once namespaces existed.
- **A diagnostic sentence no longer renders as a vendor name.** Three renderers reached past a null
  vendor into the unresolved reason; the reason now has its own place.
- Jurisdiction and confidence handling, SARIF `role` output, and several test and help-text gaps.

### Changed

- The findings schema gained `reference` and `scan.exclude` **in place**. Nothing has been
  published, so `1.1.0` was corrected rather than superseded. That option closes at the first
  release; after it, a meaning change needs a new schema file.
- `pnpm schema:check` now compares signal kinds as well as rule ids. Its header always claimed it
  guarded both enums; only one was checked.

### Knowledge base — `2026.09.10` → `2026.09.21`

- Namespace aliases `@sentry/*`, `@clerk/*` and `@aws-sdk/*`, beside the existing exact entries,
  which are kept because they carry `kind` and `kind` decides confidence.
- A fifth alias `kind`, `scope`, for a namespace match. It is deliberately not `official-sdk`: a
  namespace also holds build plugins and test helpers.
- Four AWS client constructors — `BedrockRuntimeClient`, `TextractClient`, `SecretsManagerClient`,
  `CloudWatchClient`. Their absence is why the region analyzer reported nothing on repositories
  where a region appears in dozens of files.
- `kb:validate` now rejects a namespace that swallows another vendor's alias, and an alias whose
  `kind` disagrees with its name.

## [0.1.0] — unreleased

The initial build: discovery, manifests, call sites, merge, exposure rules, the findings schema,
the CLI, the MCP server, the knowledge base, and the two Claude Code skills. Never published.
