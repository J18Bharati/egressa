# Security

## Reporting

Report a vulnerability through GitHub's private vulnerability reporting on this repository. Please
do not open a public issue for a security problem.

## Threat model

Adequacy runs locally against source code you already have. It makes no network calls, has no
telemetry, requires no credentials, and never reads `node_modules`. The realistic risks are
therefore:

- **Malicious input files.** A crafted source file or lockfile could try to exploit a parser. All
  parsing goes through `oxc-parser`, `jsonc-parser` and `yaml`; parse failures are caught per file
  and reported as non-fatal errors rather than crashing the scan.
- **Path traversal.** The scanner only reads beneath the root it is given, and the MCP server
  exposes no write tools and no path escape.
- **Supply chain.** Releases are published with npm provenance via GitHub OIDC. Verify with
  `npm view adequacy provenance`.

## Not a security scanner

Adequacy reports data-transfer exposure, not vulnerabilities. It deliberately does not set
`security-severity` in SARIF output, because filing a privacy finding in a Security tab dressed as
a CVE would misrepresent what it found.
