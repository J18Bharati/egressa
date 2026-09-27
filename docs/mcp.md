# MCP server


> **Not published yet.** The `npx` invocations below will work once the packages are on npm.
> From a checkout, run the built server directly: `node packages/mcp/dist/server.js`.
Exposes the scanner and the knowledge base to any MCP-capable client.

## Configure

```json
{
  "mcpServers": {
    "egressa": {
      "command": "npx",
      "args": ["-y", "@egressa/mcp@latest"]
    }
  }
}
```

In Claude Code: `claude mcp add egressa -- npx -y @egressa/mcp@latest`

## Tools

| Tool | Purpose |
|---|---|
| `scan_repository` | Scan a local path. Returns a token-budgeted summary by default; `full: true` for the whole findings document, `maxFindings` to bound it, `assumeAdequacyLapsed: ["US:DPF"]` to model a lapse, `exclude: ["tools/**"]` to skip globs during discovery, added to the repository's own `.egressa.yml` excludes |
| `lookup_vendor` | Full sourced entry by vendor id, package name or host |
| `list_vendors` | Every entry with jurisdiction and EU-region scope |
| `check_package` | Pre-install check: does this package belong to a known vendor, and where does it process? |
| `check_host` | Same for a hostname, resolved through the suffix trie |
| `explain_rule` | What a rule id means and how it is derived |

There are no write tools and the server makes no network calls.

`scan_repository` applies the repository's `.egressa.yml`, the same way the CLI does. Its excludes
come first in `scan.exclude`, followed by any `exclude` argument. A finding its suppressions accept is
kept and marked `suppressed`, with the reason, and never removed. `scan.config`, in the summary and
in the full document, names the file, or is `null` when there is none, so an agent can report that a repository excluded or
accepted something itself. A config that cannot be honoured (a malformed file, a suppression with no
reason, a negated glob) is a tool error, not a scan.

## Prompt

`transfer-review` walks a repository scan and instructs the model to open the evidence files, judge
whether each call site is live production code, and summarise within the claim scope.

## Token budgeting

`scan_repository` returns a summary plus the strongest findings, with evidence truncated to three
locations per finding, and sets `truncated` and `omittedFindings` when it withheld anything. It also
carries the scan's `errors`, fatal and not, up to twenty with `omittedErrors` counting the rest: a
path that does not exist returns its fatal error rather than an empty summary that reads as clean. A full
findings document for a repository with thirty vendors will otherwise flood a model's context, and
an agent that runs out of room mid-review is worse than one that asked for more.

The summariser lives in `@egressa/core`, so an agent's view and the CLI's markdown output can
never disagree about what a scan said.

Each summarised finding also carries `referenceOnly`, computed over the full evidence array before
truncation: true when every piece of evidence is a vendor merely *named* in source (`reference`)
rather than a resolved call site (`callsite`). A finding can hold several `dependency` and
`reference` entries with the distinguishing evidence cut by the three-per-finding limit above, so
the flag is what survives that cut -- do not infer reference-only-ness from the truncated
`evidence` array.

## Verified transcript

The server is exercised in CI over a real stdio transport by
`packages/mcp/src/server.test.ts`, which asserts the tool list, that every tool description carries
the claim scope, truncation behaviour, and adequacy-lapse modelling.
