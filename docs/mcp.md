# MCP server

Exposes the scanner and the knowledge base to any MCP-capable client.

## Configure

```json
{
  "mcpServers": {
    "adequacy": {
      "command": "npx",
      "args": ["-y", "@adequacy/mcp@latest"]
    }
  }
}
```

In Claude Code: `claude mcp add adequacy -- npx -y @adequacy/mcp@latest`

## Tools

| Tool | Purpose |
|---|---|
| `scan_repository` | Scan a local path. Returns a token-budgeted summary by default; `full: true` for the whole findings document, `maxFindings` to bound it, `assumeAdequacyLapsed: ["US:DPF"]` to model a lapse |
| `lookup_vendor` | Full sourced entry by vendor id, package name or host |
| `list_vendors` | Every entry with jurisdiction and EU-region scope |
| `check_package` | Pre-install check: does this package belong to a known vendor, and where does it process? |
| `check_host` | Same for a hostname, resolved through the suffix trie |
| `explain_rule` | What a rule id means and how it is derived |

There are no write tools and the server makes no network calls.

## Prompt

`transfer-review` walks a repository scan and instructs the model to open the evidence files, judge
whether each call site is live production code, and summarise within the claim scope.

## Token budgeting

`scan_repository` returns a summary plus the strongest findings, with evidence truncated to three
locations per finding, and sets `truncated` and `omittedFindings` when it withheld anything. A full
findings document for a repository with thirty vendors will otherwise flood a model's context, and
an agent that runs out of room mid-review is worse than one that asked for more.

The summariser lives in `@adequacy/core`, so an agent's view and the CLI's markdown output can
never disagree about what a scan said.

## Verified transcript

The server is exercised in CI over a real stdio transport by
`packages/mcp/src/server.test.ts`, which asserts the tool list, that every tool description carries
the claim scope, truncation behaviour, and adequacy-lapse modelling.
