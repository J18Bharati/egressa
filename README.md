# Egressa

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

Point it at a JavaScript or TypeScript repository. It tells you which third-party vendors your code
references, where those vendors process data, and what your exposure is if EU-US adequacy lapses.

**Nothing is published to npm yet.** Today it installs as a Claude Code plugin, which brings both
skills and the write-time hook:

```
/plugin marketplace add egressa-dev/egressa
/plugin install egressa@egressa
```

Or from a checkout:

```bash
pnpm install && pnpm build
node packages/cli/dist/cli.js scan .
```

Once published, `npx egressa scan .` will be the one-liner. The commands below show the CLI as
`egressa` for readability.

No account, no API key, no telemetry, no network calls. Runs entirely offline against a knowledge
base shipped alongside the binary.

## What it cannot see

Read this before trusting a clean scan.

- **Server-side proxying.** If your frontend calls your own backend and the backend calls the
  vendor, the transfer is invisible unless that backend is in the scanned repository. This is the
  largest structural blind spot and no static scanner can close it.
- **Runtime-configured destinations.** A host that arrives from an environment variable is reported
  as `transfer/unresolved-egress`, naming the variable. Egressa never guesses a host.
- **Vendors not in the knowledge base**, reported as `transfer/unknown-vendor-egress`. The knowledge
  base is a curated seed set of 15 vendors, not a census. The transfer triage skill will research an
  unknown vendor from primary sources and draft a knowledge base request; it will not research an
  unresolved *host*, because that answer is in your deployment configuration rather than on the web.
- **Non-JavaScript surfaces** — tag managers, CSP headers, native mobile, infrastructure config.
- **Call sites, when the native parser is unavailable** on the platform. The scan falls back to
  dependency manifests alone and says so (`engine.degraded`). A vendor called by URL with no SDK
  installed is invisible in that mode, so a clean degraded scan means very little.

A finding means your code *references* a vendor. It does not mean personal data was sent, that the
data was personal, or that sending it was unlawful. See [docs/CLAIMS.md](docs/CLAIMS.md).

## Scoping what gets scanned

`node_modules` is never walked, in any mode. Beyond that, four mechanisms decide what's read, and
they combine rather than compete:

- **`.gitignore`** is honoured automatically.
- **`.egressaignore`**, same syntax, for anything you want out of a scan without taking it out of
  version control.
- **`exclude:` in `.egressa.yml`** — a list of globs, the natural place for a team's standing
  exclusions: a deprecated tree, generated output, a vendored copy nobody wants findings against.
- **`--exclude <glob>`**, repeatable on the command line, for narrowing a single run. It's added to
  whatever `exclude:` already lists, not swapped in for it — the common case is "also skip this,
  just this once," not "stop honouring what the team committed."

`.egressa.yml` is applied by the engine, so the MCP server honours it exactly as the CLI does: its
excludes, and its suppressions, which mark a finding suppressed rather than remove it. The MCP
summary names the file in `scan.config`, because an agent scanning someone else's repository should
be able to say that the repository scoped its own scan.

```bash
egressa scan . --exclude 'legacy/**' --exclude '**/*.generated.ts'
```

## The surfaces

One engine. All of these consume the same versioned findings schema.

| | |
|---|---|
| **CLI** | `egressa scan .` — human, JSON, SARIF or markdown output. Not on npm yet; build from a checkout |
| **GitHub Action** | `uses: egressa-dev/egressa@v1` — findings appear as PR annotations via code scanning |
| **MCP server** | `claude mcp add egressa -- npx -y @egressa/mcp@latest` — once published; see [docs/mcp.md](docs/mcp.md) |
| **Transfer triage skill** | Triages the findings a scanner cannot judge alone, and researches vendors the knowledge base does not know — see [skill/egressa](skill/egressa/SKILL.md) |
| **Privacy review skill** | A wider review pass the engine does not perform: trackers firing before consent, personal data in logs, session replay recording inputs, storage with no expiry, opt-out signals. See [skill/privacy-review](skill/privacy-review/SKILL.md) |

| **Plugin** | `/plugin marketplace add egressa-dev/egressa` then `/plugin install egressa@egressa` — installs both skills and the write-time hook in one step |

The last one is a different kind of thing from the others and the difference matters. The engine is a
parser with a sourced knowledge base, and its answers are reproducible. The review skill is a set of
checklists an agent applies by reading code, so its findings carry an extra axis — whether the
question is settled by the source at all — and anything that is not settled ends in a question for
you rather than an instruction. Neither surface scores anything.

## The write-time hook

The plugin registers a `PreToolUse` hook on `Write` and `Edit`. When a tracker init, a
session-replay init, or a non-essential storage write is about to be added to a source file, it
names the provision that pattern engages and asks the question that decides it.

**It never blocks an edit.** It emits no permission decision and cannot return the exit code that
would stop a tool call — a test asserts both, because the temptation to block "just the bad one"
will come back. The tool detects; it does not adjudicate, which is the same reason nothing in the
scanner defaults to `error`.

It also stays quiet unless it is confident. Storage that is strictly necessary — session, CSRF,
load balancer, a preference the user set — is exempt in the text of Art 5(3) itself and is never
reported. Neither is an edit that already carries its own consent check, a test file, a fixture, or
this repository's own checklists, which necessarily contain every pattern it looks for. Each
finding is reported once per file per session.

## What breaks if adequacy falls

The EU-US Data Privacy Framework is in force and under legal challenge. To see your position if it
were withdrawn:

```bash
npx egressa scan . --assume-adequacy-lapsed US:DPF
```

That flag rewrites one decision's status in `kb/adequacy-status.json` and lets the ordinary rule
table re-rate everything. A vendor covered today becomes a third-country transfer, and the
distinction between vendors that document an EU region and those that do not becomes the thing that
matters.

Note that the framework covers only organisations that self-certified and appear on the DPF list —
it is not blanket US adequacy. Two US vendors in the same repository can therefore carry different
rules, and they do.

## Licensing

Code is Apache-2.0. The vendor knowledge base in [`kb/`](kb/) is licensed separately under
CC-BY-4.0 so anyone — including competing tools — can build on it. It is independently authored
from vendor and regulator primary sources; see [kb/PROVENANCE.md](kb/PROVENANCE.md).

Every knowledge base entry cites its sources and carries a `lastVerified` date. If an entry is
wrong, [open a correction](.github/ISSUE_TEMPLATE/vendor-correction.yml) — factual corrections with
a primary source are merged the same day, and the entry is marked disputed immediately. See
[kb/KB_POLICY.md](kb/KB_POLICY.md).
