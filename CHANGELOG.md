# Changelog

Notable changes to Egressa. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

**Engine and knowledge base are listed separately on purpose.** The knowledge base is versioned
data that consumers pin and diff, and a knowledge base update can change what a scan reports with
no code moving at all. A reader working out why today's findings differ from last week's needs to
know which half moved. Knowledge base versions are dates (`kb.version`); the tool version is semver.

Nothing has been published yet — there is no npm release and no git remote — so every version below
describes the state of the repository rather than an artifact anyone can install.

## [Unreleased]

Knowledge base `2026.09.26`. Findings schema `1.1.0`, edited in place.

### Added

- **Python dependency manifests are read.** `requirements*.txt` and `pyproject.toml` (PEP 621
  dependencies and extras, PEP 735 groups, Poetry tables), with PEP 503 name normalisation and
  dev-only detection. Both field tests missed Twilio in five production files because no Python
  manifest was read. Declared dependencies only, and no Python call sites. A `requirements.txt`
  compiled by pip-compile or `uv pip compile` is read as the lockfile it is: only packages its
  `# via` annotations name as coming from a source file are declared, and the rest are transitive.
  Installed packages are not read, for the same reason as `node_modules`: `site-packages`,
  `dist-packages`, `__pypackages__`, any dot directory, and any directory holding a `pyvenv.cfg`,
  whatever it is named. A `pyproject.toml` is read with a small TOML tokeniser, so a multi-line
  string, an array of tables or an inline table cannot be read as a dependency.
- **`pnpm build` ends by booting both binaries.** `scripts/smoke-dist.mjs` runs `egressa --version`,
  connects an MCP client to `egressa-mcp`, and has each one scan a small repository. It fails the
  build unless both scans used the native parser and the knowledge base shipped beside that binary.
  No test could catch a bundle that does not boot, because vitest aliases every package to its source.
- **`pnpm smoke:pack`** runs the same check against the four packed tarballs installed in a clean
  `node:20-slim` container. It is manual because it needs Docker and the registry.
- **An unmapped region is marked.** Evidence carries `regionUnmapped: true` when a region is not in
  the vendor's map, and the human title reads `(eu-wset-1 [unmapped])` rather than rendering it like
  a resolved region. The exposure engine already refused to narrow on one.

### Fixed

- **`SCOPE_OPT_OUT` was computed and used for nothing**, and SKILL.md did not say so. It is now
  documented as a context gate. The opt-out signals checklist stays routed on the tracker gates,
  because its own scope rule is to report nothing without an advertising tracker. A test fails on
  any future gate that is neither routed nor listed as context.
- **A flag citty would ignore was accepted.** `egressa scan . --exlude 'legacy/**'` scanned
  everything and exited 0. The CLI now accepts exactly what citty honours, and anything else is a
  usage error (exit `2`) that names it. That includes the camelCase spelling (`--failOn note` was
  accepted and ignored), `=value` on a boolean, and a string flag whose next token starts with `-`,
  which citty does not take as its value — write `--exclude=-legacy/**`.
- **An `exclude` glob that cannot be honoured is refused on every surface.** A negated glob
  (`!legacy/**`) or a non-string entry is a usage error in the CLI, a tool error in MCP, and a
  `TypeError` from `scan()`. A single-glob `exclude:` in `.egressa.yml` is now one glob; it used to be
  spread into single characters and excluded nothing. Every `.egressa.yml` error now exits `2`
  rather than `3`.
- **The MCP server could not start.** `dist/server.js` threw `Dynamic require of "process" is not
  supported` at import, because its build dropped the `createRequire` banner the CLI carries for
  exactly that error. Both builds now import one banner from `tsup.banner.ts`.
- **`egressa --version` exited 1** with "No version specified". The root command carried no
  version for citty to print.
- **A Terraform region nested inside a provider block was read as the provider's region.**
  `default_tags { tags = { region = "emea" } }` produced a second AWS finding titled `(emea)` at
  high confidence. Only the provider block's own level is read now.
- **A Terraform or Fly region in a comment or a string was read as the declared region**, and a
  brace inside a string moved the block depth. Each line is now scanned for strings, `${...}`
  interpolation and comments, and only code counts. Found by the branch review, in the first
  version of the nested-block fix above.
- **An unmapped region's audit trail depended on signal order.** `exposure.inputs` came from the
  group's first signal only. It now lists every unmapped region the evidence carries.
- **`egressa -v` exited 1.**
- **`sts_region` was read as `region`.** The key lookup had no boundary, so any key ending in
  `region` inside `provider "aws"` matched. A key must now stand alone. In HCL and TOML a hyphen
  counts as part of a key.
- **The privacy review's session-replay gate did not know replay configured inside Sentry or
  Datadog**, so `Sentry.replayIntegration()` never dispatched the specialist. The write-time hook had
  the same gap. The specialist's masking table gains Sentry Replay and Datadog RUM rows, each
  checked against a primary source. Datadog's default has changed across major versions
  (`mask-user-input`, then `mask`, then `mask-user-input`). Every documented version masks inputs,
  and the row records the history rather than a single value.

- **A heredoc, a template directive or a TOML multi-line string could produce a region the file
  does not declare.** A heredoc that writes a `provider "aws"` block was reported as `us-west-2` at
  high confidence and narrowed the jurisdiction. The region reader now carries heredocs,
  interpolations, strings and multi-line strings across lines, and recognises `%{…}`. In `fly.toml`,
  `primary_region` is read only as a top-level key, so `[env]` and multi-line strings no longer
  contribute one. A single-quoted `primary_region` is now read. A comment inside an interpolation is
  honoured, a `provider` block counts only at the top level of the file, and a literal must be the
  whole value, not the first operand of an expression.
- **A compiled `requirements.txt` made every transitive package a direct, high-confidence vendor.**
  See the Python entry under Added: pip-compile and uv output is now read as a lockfile. A source
  in a subdirectory or a dependency group counts as a source, and a `# via` parent that is not in
  the file is taken as the project itself, so no declared SDK is dropped. Only a bare package name
  counts as that parent, and not one the generator's trailer lists as excluded from the output.
- **uv's `--emit-index-annotation` brought the transitive-package problem back.** Its
  `# from <index>` line after a multi-parent `# via` block was read as a parent named `from`, absent
  from the file and so the project: `botocore` became AWS at high confidence. A via block now ends
  at any comment that is not a `#   <entry>` line. `# via pkg[extra]` names `pkg`, and an
  annotation on a `--hash` continuation line is read. The reader is tested against real
  `uv pip compile` and `uv export` output, regenerated offline by
  `scripts/gen-compiled-requirements.sh`.
- **The MCP server ignored `.egressa.yml`.** Through MCP a team's suppressed finding came back
  unsuppressed and its excluded tree was scanned. Loading and applying the config moved into core,
  so both surfaces apply it. The MCP summary now carries each finding's suppression and names the
  file in `scan.config`. A config error of any kind, including malformed YAML, names the file and is a
  usage error (CLI exit 2, MCP tool error).
- **Only the MCP summary said a repository's own config was applied.** `scan.config` is now part
  of the findings document itself (schema `1.1.0`, optional), so the CLI's JSON and MCP's full
  document name the file too, or say `null`.
- **A suppression that matched nothing said nothing.** `vendor: Stripe` (the id is `stripe`) loaded,
  matched no finding, and read as an accepted risk. The scan now reports, as a non-fatal error, a
  suppression naming a vendor or rule that does not exist (with a hint for a case slip), one that
  matched no finding, qualified when the scan was narrowed and it might match in a full one, and
  one whose every match an earlier suppression already takes.
- **The MCP summary dropped the scan's errors, fatal ones included.** A mistyped path returned an
  empty summary that read as a clean scan, and a parse warning never reached the agent. The
  summary now carries `errors` (up to twenty, with `omittedErrors`). Markdown output gains a
  Warnings section, and SARIF reports each error as a `toolExecutionNotifications` entry on the
  run's invocation, so a GitHub code-scanning user sees them too.
- **An expired-suppression note was appended after every other finding, and was not counted.** It
  now follows the finding it reactivates, and a truncated MCP summary that keeps the finding keeps
  the note too, even one past `maxFindings`, and it counts in `byRule` and `bySeverity` like any other finding.
- **`egressa vendors show` and MCP `lookup_vendor` tried npm only**, so `boto3` had "no knowledge base
  entry". They now try PyPI too, and answer nothing when npm and PyPI name different vendors. MCP
  `check_package` compares a PyPI name in PEP 503 form, so `Twilio` matches.
- **`--out=-` wrote a file named `-`.** It now means stdout.
- **`.egressa.yml` is validated as a whole.** Every suppression field must be text, a suppression
  must name a vendor or a rule, and `expires` must be a date. An unparseable one used to compare as
  never expiring. A `--config` path that does not exist is refused, and every config failure is a
  usage error, never exit 1. `--no-include-transitive` overrides a config that turns it on.
- **A `.egressa.yml` symlinked outside the repository is refused, and a YAML error no longer quotes
  the file.** Through MCP, the quoted lines of whatever file the link pointed at reached the agent.

### Knowledge base — `2026.09.21` → `2026.09.26`

- `pypi` aliases for Twilio (`twilio`) and AWS (`boto3`, `botocore`), each checked against the
  publisher on PyPI.
- `kb:validate` rejects a `pypi` alias that is not in PEP 503 normalised form, which could never
  match, and a `pypi` wildcard, since PyPI has no namespaces.

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
- Jurisdiction and confidence handling, and several test and help-text gaps. A jurisdiction's
  `role` is still discarded before output; see `TODOS.md`.

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
