# @egressa/mcp

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

A stdio MCP server that exposes the Egressa scanner and its vendor knowledge base to any MCP client.
It has no write tools and makes no network calls. Project overview and limitations: the
[main README](https://github.com/J18Bharati/egressa#readme).

<!-- Remove this note at the first npm release. -->
Until the first npm release, run the built server from a checkout:
`node packages/mcp/dist/server.js`.

```json
{
  "mcpServers": {
    "egressa": { "command": "npx", "args": ["-y", "@egressa/mcp@latest"] }
  }
}
```

In Claude Code: `claude mcp add egressa -- npx -y @egressa/mcp@latest`. The package also installs an
`egressa-mcp` binary. Requires Node 20.11 or later.

| Tool | Purpose |
|---|---|
| `scan_repository` | Scan a local path. Returns a summary sized for a model's context by default; `full: true` for the whole findings document |
| `lookup_vendor` | A full sourced entry, by vendor id, package name or host |
| `list_vendors` | Every entry, with jurisdiction and EU-region scope |
| `check_package` | Whether a package belongs to a known vendor, and where that vendor processes data |
| `check_host` | The same for a hostname |
| `explain_rule` | What a rule id means and how it is derived |

There is also a `transfer-review` prompt. `scan_repository` applies the repository's `.egressa.yml`
the same way the CLI does, and returns the scan's errors rather than an empty summary when a path
does not exist. Details: [docs/mcp.md](https://github.com/J18Bharati/egressa/blob/main/docs/mcp.md).

Code is Apache-2.0. The bundled knowledge base in `kb/` is CC-BY-4.0.
