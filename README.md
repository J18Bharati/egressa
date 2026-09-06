# Adequacy

> Adequacy detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

Point it at a JavaScript or TypeScript repository. It tells you which third-party vendors your code
references, where those vendors process data, and what your exposure is if EU-US adequacy lapses.

```bash
npx adequacy scan .
```

No account, no API key, no telemetry, no network calls. Runs entirely offline against a knowledge
base shipped in the package.

## What it cannot see

Read this before trusting a clean scan.

- **Server-side proxying.** If your frontend calls your own backend and the backend calls the
  vendor, the transfer is invisible unless that backend is in the scanned repository. This is the
  largest structural blind spot and no static scanner can close it.
- **Runtime-configured destinations.** A host that arrives from an environment variable is reported
  as `transfer/unresolved-egress`, naming the variable. Adequacy never guesses a host.
- **Vendors not in the knowledge base**, reported as `transfer/unknown-vendor-egress`. The knowledge
  base is a curated seed set, not a census.
- **Non-JavaScript surfaces** — tag managers, CSP headers, native mobile, infrastructure config.

A finding means your code *references* a vendor. It does not mean personal data was sent, that the
data was personal, or that sending it was unlawful. See [docs/CLAIMS.md](docs/CLAIMS.md).

## Licensing

Code is Apache-2.0. The vendor knowledge base in [`kb/`](kb/) is licensed separately under
CC-BY-4.0 so anyone — including competing tools — can build on it. It is independently authored
from vendor and regulator primary sources; see [kb/PROVENANCE.md](kb/PROVENANCE.md).

Every knowledge base entry cites its sources and carries a `lastVerified` date. If an entry is
wrong, [open a correction](.github/ISSUE_TEMPLATE/vendor-correction.yml) — factual corrections with
a primary source are merged the same day, and the entry is marked disputed immediately. See
[kb/KB_POLICY.md](kb/KB_POLICY.md).
