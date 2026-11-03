# egressa

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

The command-line scanner. It lists the third-party vendors a repository's code calls or depends on,
where each vendor processes data according to the bundled knowledge base, and which transfer
mechanism that rests on. It runs offline, with no account, no API key and no telemetry.

<!-- Remove this note at the first npm release. -->
Until the first npm release, build it from a checkout as the
[main README](https://github.com/J18Bharati/egressa#readme) describes.

```bash
npx egressa scan .
```

Requires Node 20.11 or later. Call-site analysis uses the native `oxc-parser` binding; on a platform
with no prebuilt binding the scan reads dependency manifests only and says so
(`scan.engine.degraded: true` in JSON).

## Commands

```bash
egressa scan .                                      # human-readable report
egressa scan . --format sarif --out egressa.sarif   # also json, markdown
egressa scan . --fail-on warning                    # exit 1 at or above this level
egressa scan . --exclude 'legacy/**'                # repeatable; adds to .egressa.yml
egressa scan . --assume-adequacy-lapsed US:DPF      # re-rate as if the decision were withdrawn
egressa vendors list                                # the knowledge base roster
egressa vendors show stripe                         # one entry, with its sources
egressa explain transfer/unresolved-egress          # what a rule means
egressa schema findings                             # the findings JSON Schema
```

`egressa scan --help` lists every flag. An unknown flag is a usage error, not ignored.

| Exit code | Meaning |
|---|---|
| 0 | Scan ran; nothing at or above `--fail-on` (default `none`) |
| 1 | Findings at or above `--fail-on` |
| 2 | Usage or configuration error |
| 3 | Internal error |
| 4 | The knowledge base could not be loaded |

## Before trusting a clean scan

A clean scan means no known vendor was matched by the analyzers that ran. A vendor called from a
backend that is not in the scanned repository, a host supplied at runtime, a constant imported from
another file, and a vendor with no knowledge base entry are all outside what it can report. A
finding means the code references a vendor, not that personal data was sent. See
[LIMITATIONS.md](https://github.com/J18Bharati/egressa/blob/main/docs/LIMITATIONS.md).

## Licence

Code is MIT-licensed. The bundled knowledge base in `kb/` is CC-BY-4.0.
