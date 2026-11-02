# Changelog

Notable changes to Egressa. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

**Engine and knowledge base are listed separately on purpose.** The knowledge base is versioned
data that consumers pin and diff, and a knowledge base update can change what a scan reports with
no code moving at all. A reader working out why today's findings differ from last week's needs to
know which half moved. Knowledge base versions are dates (`kb.version`); the tool version is semver.

<!-- Update at the first release: the next sentence stops being true then. -->
Nothing has been published yet — there is no npm release and no git remote — so every version below
describes the state of the repository rather than an artifact anyone can install.

## [Unreleased]

Knowledge base `2026.11.03`. Findings schema `1.1.0`, edited in place.

This section will become the first published release. The entries under **Fixed** and **Changed**,
here and in the versions below, record defects and decisions in the repository before anything was
published: no published version had them. They are kept because they explain why the tool
behaves as it does. Schema `1.1.0` was corrected in place for the same reason: no consumer had it.

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

- **Any call carrying a `baseURL` literal was a high-confidence call site.** An SDK whose default
  export takes its destination as an option (`new OpenAI({ baseURL })`) is matched on the option
  alone, so a test assertion, a mock expectation, a Playwright page or an in-house HTTP factory
  matched too. A sample of 21 public repositories found 14 such call sites in one of them. The option
  is now a call site only when the file imports a module that declares it (an import, re-export,
  `require`, dynamic `import()` or `import x = require()`, matching exactly or by subpath), and a
  `reference`, capped at medium, otherwise.
- **Loopback and documentation hosts were reported as unknown vendors.** `localhost` and names under
  it, `127.x.x.x`, `[::1]`, `example.com`/`.net`/`.org` and the `.test`, `.example` and `.invalid`
  names are reserved by RFC 2606 and RFC 6761, so no third party can hold them, and they are no
  longer reported. A hit a vendor's client attributed keeps the vendor, and private address ranges
  are still reported.
- **A request on an axios client reported the client's base URL, even when the request URL was
  absolute.** `axios.create({ baseURL: 'https://api.stripe.com' })` followed by
  `api.get('https://evil.example/x')` was Stripe at high confidence; axios sends it to
  evil.example. Requests are now resolved by axios's own `buildFullPath` rule, checked against
  axios 1.12.2: the request URL when it is absolute, the base URL when it is relative or
  `allowAbsoluteUrls` is `false`, and unresolved when the request URL could be either -- an unknown
  variable, a protocol-relative URL, or a template whose static text does not rule out a scheme. The
  same rule replaces a first-key-wins read of `axios({ baseURL, url })`, which reported the base
  for an absolute `url`, and a `baseURL` or `allowAbsoluteUrls` in a request config literal is now
  read. Anything that could set `allowAbsoluteUrls` unseen -- a config passed by name, a spread or
  computed key, a `defaults` object reached in the file other than through its other named keys --
  makes an absolute request URL unresolved, and a request `url` a spread could set is unresolved. A
  request config passed by name or spread is assumed not to carry a `baseURL`, and interceptors are
  not followed; both are recorded in `docs/LIMITATIONS.md`. Neither a real backend codebase nor the
  fixture repositories use axios, so their scans are unchanged.
- **A connection URI could resolve to a host its client does not connect to.** For non-special
  schemes the first `host[:port]` was taken: `mongodb://a.example.com:27017,evil.com/` reported
  a.example.com, and `postgres://api.stripe.com:p#w@evil.example/` reported api.stripe.com, where
  libpq reads the userinfo up to the `@` and connects to evil.example. A host list, an `@` after a
  `?` or `#`, more than one `@`, a `\` or a character legacy `url.parse` ends a hostname at in the
  authority, a `host=` or `hostaddr=` query parameter (percent-encoded or after a `#` too), and an
  interpolation in the query that could supply one are now unresolved. Only the `new URL()` reference sink reaches these today, so a declined URI
  reports nothing.

- **A symlink could make a scan read, and quote, a file outside the repository.** The walk followed
  links and nothing checked where a file really lived, so a committed
  `pnpm-lock.yaml -> ~/.aws/credentials` was read and the YAML parser's error -- which quotes the
  line it failed on -- carried that line into JSON, SARIF and the MCP result; a linked source file
  outside the root produced findings with its snippets. Links are no longer followed, every reader
  refuses a path whose real location leaves the root or is not a regular file -- a FIFO committed
  as `.gitignore` used to hang the scan and the MCP server -- and lockfile parse errors keep only
  their first line. A read error reports its code rather than a message carrying the reviewer's
  absolute path. No finding changed across a real backend codebase and every fixture repository.

- **The privacy review could run a command the reviewed repository supplied, through git.**
  `scope.sh` runs `git ls-files` and `git diff` inside the repository under review, and a
  repository handed over with its `.git` directory -- an archive, a shared folder -- brings its own
  `.git/config`, whose `core.fsmonitor` git runs on every index refresh: silently, at step one of a
  review presented as read-only. Every git call now goes through a wrapper that disables
  `core.fsmonitor`, hooks, an external diff, the pager and submodule recursion; every clean, smudge
  and process filter driver is blanked -- git otherwise runs one on each re-dated file an extracted
  archive leaves; and no git command can reach a transport, which closes a partial clone's lazy
  fetch running the repository's `core.sshCommand`, credential helper or `ext::` command. Git is believed
  only about this directory -- not a parent repository, not one a `.git` file points to, not past
  a `.git` holding a FIFO, not a git older than 2.31 -- and never about a path outside it: a crafted
  tree made git list `../outside/secret.js`, which was grepped and handed to specialists. A git
  command that fails or times out (15 seconds, after which git is not asked again), or an index
  that lists nothing over a populated tree, is now reported as degraded with a `find` fallback, and
  the skill carries that into the report. A `package.json` that is a FIFO no longer hangs the
  stack check, nor is one linked from outside the repository read. Untracked files, a partially
  crafted index, unbounded git calls on macOS and worktree checkouts are documented gaps; a failed diff used to
  produce an empty file set that read as a clean review. `SKILL.md` no longer tells specialists to run
  `git ls-files` or `git diff`; they get the file set from `scope.sh --list`. A clone cannot carry
  `.git/config`, which is why no fixture caught it.
- **The privacy review read through committed symlinks.** `scope.sh` grepped a linked file outside
  the repository and could raise `SIGNAL_TRACKERS_NO_CONSENT` from it, and handed it to specialists
  to read. Links, and paths under linked directories, are now dropped, checked against the
  filesystem per path; a path whose name holds a newline is reported as not reviewed rather than
  split, which is how a link named `zz<newline>src` could hide every file under `src/`.

- **A concatenation could attribute a host it did not name.** `fetch(B + '.attacker.example/x')`,
  with `B = 'https://api.stripe.com'`, reported Stripe at high confidence: the left operand was read
  as a complete URL without looking at what followed it. Leading static text is now folded across
  literals, template chunks, `+` and stable module-scope strings, and the authority is read once
  from the folded text, so that call reports `api.stripe.com.attacker.example`. `BASE + path` with
  an unknown `path` and no delimiter in `BASE` is now unresolved rather than a guess; across a
  real backend codebase and every fixture repository, no resolution was lost to it.
- **Three more ways to resolve a host that was not the destination**, found reviewing the fold above,
  each a confident wrong host. Binding collection counted only `const`/`let` declarators, so a
  parameter, `catch` clause or destructured name shadowing a module constant resolved to the
  module's value -- `function client({ apiUrl }) { fetch(`${apiUrl}/v1`) }` reported the vendor in
  the module's `apiUrl`; parameters, `catch` and destructuring now count. A `://` anywhere in the string was taken as
  the scheme, so `fetch('/proxy?u=https://api.stripe.com/v1')` reported Stripe; the scheme must now
  start the string. And a backslash did not end the authority, so
  `https://api.stripe.com\@evil.example/x` reported `evil.example`; for the special schemes the
  authority is now read by the WHATWG URL parser itself, which also fixes IPv6 literals (reported
  as `[`), percent-escapes, embedded tabs and leading whitespace, and reports nothing for an
  authority `fetch` would reject. TypeScript `enum`, `namespace` and `import X =`, `with`, direct
  `eval` and `globalThis.X =` writes also stop a name resolving. A `new URL()` read while resolving
  a discarded head is no longer silently consumed.
- **`'https://' + process.env.HOST + '/v1'` now reports `unresolved-egress`.** It produced no
  finding before, because the left operand alone had no authority and was read as not a URL.
- **A template led by a constant did not resolve.** `` fetch(`${GMAIL_API_BASE}/watch`) `` reported
  `unresolved-egress` although the constant was a plain module-scope string. The same fold resolves
  it, and lifts the documented false negative for `` new URL(`${API_BASE}/messages`) ``. An
  unresolved leading value now gives its own reason -- the variable, the environment variable, the
  reassignment -- instead of the generic "built from an interpolated value".

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
  counts as that parent, and not one the generator's trailer lists as excluded from the output. A
  package whose only parents are such excluded names, or entries in no recognised shape, is read as
  declared with a warning naming it, since the file cannot say whether it was asked for: this kept
  Twilio when `uv pip compile --no-emit-package` leaves out the local project. A package naming any
  excluded parent is treated the same way, even beside a parent in the file. A full-line comment
  ending in `\` no longer swallows the next requirement. A Windows source
  path, `(backend\pyproject.toml)`, counts as a source.
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
  now follows the finding it reactivates, a truncated MCP summary that keeps the finding keeps the
  note too, even one past `maxFindings`, and it counts in `byRule` and `bySeverity` like any other
  finding.
- **`egressa vendors show` and MCP `lookup_vendor` tried npm only**, so `boto3` had "no knowledge base
  entry". They now try PyPI too. A query is read as a vendor id in any case, an npm name, a PyPI name
  and a host, and answers nothing when two readings name different vendors, where an id used to win
  over a package and a package over a host. `kb:validate` rejects the data that would make a lookup
  ambiguous: an alias that is another vendor's id or host, and one name used by different vendors on
  npm and PyPI. MCP `check_package` compares a PyPI name in PEP 503 form, so `Twilio` matches.
- **`--out=-` wrote a file named `-`.** It now means stdout.
- **`.egressa.yml` is validated as a whole.** Every suppression field must be text, a suppression
  must name a vendor or a rule, and `expires` must be a date. An unparseable one used to compare as
  never expiring. A `--config` path that does not exist is refused, and every config failure is a
  usage error, never exit 1. `--no-include-transitive` overrides a config that turns it on.
- **A `.egressa.yml` symlinked outside the repository is refused, and a YAML error no longer quotes
  the file.** Through MCP, the quoted lines of whatever file the link pointed at reached the agent.

### Changed

- **One closed table decides what a DPF list status means.** A DPF record may carry the status it was
  read from (`observedStatus`, verbatim), and `dpfCertified` must agree with it: `Active` is
  certified; `Active - Re-certification under Review`, which the DPF programme does not define, is
  not, unless a named person accepts it (`acceptQualifiedStatus`); `Inactive`, `not-listed` and any
  status the table does not know are not. `kb:validate` refuses a record that disagrees, and the
  engine applies the same table at scan time, so a `--kb` directory cannot read a status two ways.
  A certified record with no observed status is a validation warning and a verification task.
- **The authored-override layer is removed.** `kb/ratings/exposure-overrides.json` was read by
  nothing at run time. The knowledge base checks beyond the schema now live in
  `packages/kb-loader/src/checks.ts`, shared by `kb:validate` and anything that judges one entry.
- **`.egressa.yml` is read strictly.** An unknown key, a YAML merge key, a file that is not UTF-8 or
  not a mapping, a symlink that does not resolve, and anything that is not a regular file (a FIFO
  used to hang the scan) are usage errors, where each used to load as something else or as no
  config. `version` must be `1`, quoted or not. An empty `vendor`, `rule` or `expires` is refused:
  an empty vendor used to suppress its rule for every vendor. A config over 8 MB is not read, and
  the file is checked and read through one descriptor, so it cannot be swapped between the two. A config that loaded before may now exit 2; the
  message names the key and suggests the likely one.
- **A warning never repeats the scanned repository's text as markup.** A suppression naming a
  vendor or rule that is not a plain name is described, not quoted. Markdown output puts a
  warning's path in a code span and escapes its message, `@` included, so a PR comment cannot
  mention a team; human output replaces control and bidi-override characters. At most twenty
  suppression problems, and twenty markdown warnings, are listed.
- **`expires` must be ISO 8601, and a time must carry its zone.** A date on its own still ends the
  suppression at the start of that day in UTC, as Trivy, OSV-Scanner and OWASP Dependency-Check read
  theirs.
- **The privacy-review contract has a fourth decidability, `context`,** used only by the transfers
  specialist for EU and adequate-country transfers, and a `_scanner` line in which that specialist
  accounts for every scanner finding. Step 4 checks the counts and names any specialist that returned
  no block.

### Knowledge base — `2026.11.02` → `2026.11.03`

Nine vendors, from gaps a sample of 21 public repositories showed. Every fact cites a vendor or
regulator page fetched on 2026-11-02 or 2026-11-03.

- **New entries:** `sendgrid`, `vonage`, `meta-graph-api` (Graph API, Instagram, WhatsApp Cloud
  API), `telegram-bot-api`, `github-api`, `notion`, `algolia`, `huggingface`, `ipinfo`.
- **`google-apis` covers the Workspace APIs with their own hosts:** Docs, Sheets, Slides, Forms,
  Tasks and People, each the `rootUrl` in its Discovery Service document. Drive and Calendar are
  already served from `www.googleapis.com`.
- **Recorded as unknown, not guessed.** Vonage's legal pages could not be fetched, so its
  contracting entity, DPA and transfer mechanism are left empty, and Vonage is not treated as DPF
  certified. Telegram publishes no client SDK, so the common libraries are `wrapper` aliases.
  Notion's DPF record reads "Active - Re-certification under Review", and its note says so.
- **Not added:** `ip-api` and `ipify`. ip-api serves requests from servers it does not locate, so an
  entry naming only its Romanian operator would have read as EU-only processing. ipify's pages name
  no legal entity. Both stay unknown vendors, which a reviewer sees.
- **Four DPF records reclassified under the closed status table.** Auth0 (Okta, Inc.), Notion,
  Resend and the Meta Platforms, Inc. record read `Active - Re-certification under Review`, so they
  are recorded `dpfCertified: false` and Auth0, Notion and Resend are no longer cleared to the
  adequate-country rule. Meta's WhatsApp LLC record reads `Active` and stays certified, and the
  engine counts a vendor certified when any of its DPF records is. Every other DPF record now
  carries the status its entry already recorded; six (AWS, Sentry, Stripe and the three Google
  entries) recorded none and are verification tasks.

### Knowledge base — `2026.10.09` → `2026.11.02`

- **`google-apis`: Google's shared API endpoints and OAuth.** The hosts the Gmail entry deliberately
  left unmatched now name Google, without naming an API: `www.googleapis.com`,
  `oauth2.googleapis.com` and `accounts.google.com`, exact matches only, plus the general client
  packages (`googleapis`, `google-auth-library`, `google-api-python-client`, `google-auth`,
  `google-auth-oauthlib`). Google's own Discovery Service lists seven APIs rooted at
  `www.googleapis.com`, Identity Toolkit among them, which is why this is a separate entry rather
  than an extension of the Gmail one. The legal facts are those of the Google APIs Terms of Service,
  and the entry's notes record where an API's own terms take over. Gmail's dedicated host and package
  stay with `google-gmail-api`; an unlisted Google Cloud endpoint such as `storage.googleapis.com`
  stays unmatched.
- **LangChain's AWS packages** (`langchain-aws` and `langgraph-checkpoint-aws` on PyPI,
  `@langchain/aws` on npm) are AWS aliases of kind `framework-integration`: LangChain publishes them,
  not AWS, so they name AWS at medium confidence rather than the high confidence of an official SDK.

### Knowledge base — `2026.09.21` → `2026.10.09`

- **`google-gmail-api`: the Gmail API.** A field run against a Gmail-ingesting backend reported it
  as `unknown-vendor-egress`. Only the Gmail-dedicated host (`gmail.googleapis.com`) and package
  (`@googleapis/gmail`): Google's OAuth token endpoint, `www.googleapis.com` and the general client
  packages serve Google APIs generally, and host matching cannot see a path or a scope, so they stay
  unmatched rather than being filed as Gmail. Google is recorded as an independent controller under
  the Controller-Controller Data Protection Terms, so `dpa` is unavailable, with no SCC row: section
  5.3 of those terms says SCCs are not required for European data sent to Google. The EU region is
  recorded as unavailable to the API caller, with its `docUrl`, because Workspace data regions are
  set by the mailbox owner's administrator.

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
