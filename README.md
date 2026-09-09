# Egressa

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

Point it at a JavaScript or TypeScript repository. It tells you which third-party vendors your code
references, where those vendors process data, and what your exposure is if EU-US adequacy lapses.

```bash
npx egressa scan .
```

No account, no API key, no telemetry, no network calls. Runs entirely offline against a knowledge
base shipped in the package.

## What it cannot see

Read this before trusting a clean scan.

- **Server-side proxying.** If your frontend calls your own backend and the backend calls the
  vendor, the transfer is invisible unless that backend is in the scanned repository. This is the
  largest structural blind spot and no static scanner can close it.
- **Runtime-configured destinations.** A host that arrives from an environment variable is reported
  as `transfer/unresolved-egress`, naming the variable. Egressa never guesses a host.
- **Vendors not in the knowledge base**, reported as `transfer/unknown-vendor-egress`. The knowledge
  base is a curated seed set, not a census.
- **Non-JavaScript surfaces** — tag managers, CSP headers, native mobile, infrastructure config.

A finding means your code *references* a vendor. It does not mean personal data was sent, that the
data was personal, or that sending it was unlawful. See [docs/CLAIMS.md](docs/CLAIMS.md).

## The surfaces

One engine. All of these consume the same versioned findings schema.

| | |
|---|---|
| **CLI** | `npx egressa scan .` — human, JSON, SARIF or markdown output |
| **GitHub Action** | `uses: egressa-dev/egressa@v1` — findings appear as PR annotations via code scanning |
| **MCP server** | `claude mcp add egressa -- npx -y @egressa/mcp@latest` — see [docs/mcp.md](docs/mcp.md) |
| **Transfer triage skill** | Triages the findings a scanner cannot judge alone — see [skill/egressa](skill/egressa/SKILL.md) |
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
