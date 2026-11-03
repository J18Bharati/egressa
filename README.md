# Egressa

> Egressa detects third-party data-egress patterns in source code and their cross-border transfer
> exposure. It does not assess or certify GDPR compliance.

Egressa reads a repository and lists the third-party vendors its code calls or depends on, where
each vendor processes data according to a sourced knowledge base, and which transfer mechanism that
rests on. It reads JavaScript and TypeScript call sites, npm and Python dependency manifests, and
the regions declared in Terraform, Serverless, Vercel and `fly.toml` configuration.

## Who it is for

A B2B company of roughly 2 to 10 people, with no compliance function, that has sent a customer its
sub-processor list and been asked to say when that list changes.

The list is written once and then goes stale without anyone noticing: someone adds an SDK or a call
to a new API, and the document stays as it was. A questionnaire tool that drafts answers from your
previous answers will repeat the stale version. Egressa derives the vendor list from the code
itself, so running it on every pull request tells you when a code change changed the answer.

It is one input to that list, not the list. Source code shows a class of sub-processor that
inventories built from an identity provider, procurement records or a self-declared form are likely
to miss: the SDKs and API calls your product embeds. That is our reasoning from how those tools
describe their own discovery, not something any of them documents. A scanner that loads your live
website will see the client-side part of it too, so the difference is clearest for server-side and
build-time integrations. Egressa does not replace those inventories, and vendors called only from
backend code outside the scanned repository, or behind runtime configuration, are invisible to it.

## What it cannot see

Read this before trusting a clean scan. A clean scan means that no known vendor was matched by the
analyzers that ran, and nothing more.

- **Server-side proxying.** If your frontend calls your own backend and the backend calls the
  vendor, the transfer is invisible unless that backend is in the scanned repository. This is the
  largest gap, and no static scanner can close it.
- **Runtime-configured destinations.** A host that comes from an environment variable or runtime
  configuration is reported as `transfer/unresolved-egress`, naming the variable. Egressa never
  guesses a host.
- **Constants imported from another file.** Analysis is single-file, so
  `import { API_BASE } from './config'` followed by `fetch(API_BASE)` is unresolved.
- **Vendors not in the knowledge base.** The knowledge base is a curated set, not a census: 17
  vendors in version `2026.10.09`, and `egressa vendors list` prints the current roster. An unknown
  *host* is a `transfer/unknown-vendor-egress` finding. An unknown *package* is only listed under
  "Not in the knowledge base". It is not a finding, so `--fail-on` never fires on it. SendGrid in
  the example below is one.
- **Anything the parsers do not read:** Python call sites (Python dependencies are read, calls are
  not), HTML `<script src>` tags, tag manager containers, CSP headers, native mobile code and CDK
  stacks. A region in infrastructure configuration is read only when it is a literal.
- **Call sites, when the native parser is unavailable** on your platform. The scan falls back to
  dependency manifests and says so (`scan.engine.degraded` in JSON). A vendor called by URL with
  no SDK declared is invisible in that mode, so a clean degraded scan tells you very little.

A finding means your code references a vendor. It does not mean that personal data was sent, that
the data was personal, or anything about whether sending it was lawful. The full list, with the test
case behind each entry, is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md); what a finding claims is
in [docs/CLAIMS.md](docs/CLAIMS.md).

<!-- Update this section, the Action note under "Watching for changes", and SECURITY.md's
     reporting note at the first release. -->
## Status: not released yet

Nothing is published to npm, and the GitHub repository `J18Bharati/egressa` that the plugin, the
Action and the issue links refer to has not been created. **Until the first release, the only path
that works is a checkout:**

```bash
pnpm install
pnpm build
node packages/cli/dist/cli.js scan path/to/your/repo
```

This needs Node 20.11 or later and pnpm 9. The commands below are written as `egressa`; from a
checkout, that is `node packages/cli/dist/cli.js`.

After the first release, these are the install paths. None of them works today.

| Surface | Command | Needs |
|---|---|---|
| CLI | `npx egressa scan .` | npm release |
| GitHub Action | `uses: J18Bharati/egressa@v1` (see below) | npm release, repository, `v1` tag |
| Claude Code plugin | `/plugin marketplace add J18Bharati/egressa`, then `/plugin install egressa@egressa` | repository |
| MCP server | `claude mcp add egressa -- npx -y @egressa/mcp@latest` | npm release |

The scanner needs no account, no API key and no network. It runs offline against the knowledge base
shipped beside it, and there is no telemetry.

## Example

Output of the built CLI against a fixture in this repository, copied from a real run:

```
$ egressa scan fixtures/repos/express-stripe-sendgrid --no-color
i Stripe, LLC
    processing: US, IE
    EU region:  not documented
    relies on an adequacy decision that could be withdrawn
    verified:   2026-09-06
    src/pay.ts:8  api.stripe.com
    package-lock.json:8  stripe [dependency]
    package.json:7  stripe [dependency]
    Stripe, LLC data processing agreement: https://stripe.com/legal/dpa
    Stripe, LLC sub-processors: https://stripe.com/legal/service-providers

i Twilio Inc.
    processing: US, IE, DE, NL
    EU region:  available (partial)
    relies on an adequacy decision that could be withdrawn
    verified:   2026-11-02
    package-lock.json:9  @sendgrid/mail [dependency]
    package.json:8  @sendgrid/mail [dependency]
    Twilio Inc. data processing agreement: https://www.twilio.com/en-us/legal/data-protection-addendum
    Twilio Inc. sub-processors: https://www.twilio.com/en-us/legal/sub-processors

Not in the knowledge base
  express
  vitest
  No entry exists for these, so no jurisdiction can be reported.

2 findings across 2 vendors (1 file, 2 manifests, 22ms)
knowledge base 2026.11.03 (27 vendors, adequacy status as of 2026-09-06)
Detection only - not a compliance assessment.
```

`i` marks a note and `!` a warning. Nothing defaults to an error. Stripe was found three ways: a
call to `api.stripe.com` in `src/pay.ts`, and the `stripe` dependency in both manifests. "Relies on
an adequacy decision that could be withdrawn" means the transfer currently rests on the EU-US Data
Privacy Framework, whose certification list the knowledge base records Stripe on. The SendGrid
package is in the code but has no entry, so it is listed rather than reported.

Other output formats: `--format json`, `--format sarif` or `--format markdown`, with `--out <file>`
to write to a file. `egressa explain transfer/unresolved-egress` explains a rule, and
`egressa vendors show stripe` prints an entry with its sources. `egressa scan --help` lists every
flag.

## Watching for changes

There is no baseline or diff command yet. Today, watching for changes means running the scan on
every pull request. With the GitHub Action, after the first release:

```yaml
name: egressa
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
  security-events: write
jobs:
  egressa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: J18Bharati/egressa@v1
        with:
          version: <released version>  # defaults to latest; pin it
          fail-on: warning
```

The Action uploads SARIF to GitHub code scanning. Each finding carries a fingerprint built from the
vendor, the rule, the file and the matched host or package, so an unchanged finding keeps its alert
from run to run and a newly added vendor arrives as a new alert. Scanning pushes to `main` as well
gives code scanning a base branch to compare pull requests against. How these alerts render on a
live repository has not been checked yet; that check is part of the first release.

`--fail-on` works by level, not by novelty: any finding at or above the level fails the job, old or
new. The two third-country rules are warnings. Every other rule is a note, including a vendor
covered by the Data Privacy Framework, an unknown host and an unresolved one. So `--fail-on warning`
fails on a vendor with no adequacy decision behind its transfer, and not on a DPF-certified one,
which shows up only as a new alert. The Action defaults `fail-on` to `warning`; the CLI defaults to
`none`.

| Exit code | Meaning |
|---|---|
| 0 | Scan ran; nothing at or above `--fail-on` |
| 1 | Findings at or above `--fail-on` |
| 2 | Usage or configuration error, including an unknown flag or a bad `.egressa.yml` |
| 3 | Internal error |
| 4 | The knowledge base could not be loaded |

## What breaks if adequacy falls

The EU-US Data Privacy Framework is in force and under legal challenge. To see your position if it
were withdrawn:

```bash
egressa scan . --assume-adequacy-lapsed US:DPF
```

The flag marks that one decision as withdrawn and lets the ordinary rule table re-rate everything.
On the fixture above, Stripe moves from `i` to `!`, its rule changes from
`transfer/adequate-country-egress` to `transfer/third-country-egress`, and the footer adds
`hypothetical: treating US:DPF as withdrawn`. Whether a vendor documents an EU region then becomes
the distinction that matters.

The framework covers only organisations that self-certified and appear on the DPF list. It is not
blanket US adequacy, so two US vendors in the same repository can carry different rules.

## Scoping a scan, and accepting a finding

`node_modules` is never read, in any mode, and neither are installed Python packages. Beyond that,
four mechanisms decide what is read, and they add up rather than override each other:

- `.gitignore`, honoured automatically.
- `.egressaignore`, same syntax, for anything you want out of a scan but in version control.
- `exclude:` in `.egressa.yml`, for a team's standing exclusions.
- `--exclude <glob>`, repeatable, for one run. It adds to `exclude:`, it does not replace it.

```yaml
# .egressa.yml
version: 1
exclude:
  - 'legacy/**'
suppressions:
  - vendor: stripe
    rule: transfer/adequate-country-egress
    reason: Reviewed with counsel; DPF-certified and DPA signed
    acceptedBy: jane@example.com
    expires: 2027-01-31
```

A suppression marks a finding `(suppressed)` rather than removing it, and every suppression needs a
`reason`. `expires` is an ISO date, which ends the suppression at the start of that day in UTC, or a
time with its zone, such as `2027-01-31T17:00Z`. The file is read strictly: an unknown key, a YAML
merge key, a file that is not UTF-8 or not a mapping, and a symlink that does not resolve are all
usage errors (exit 2), never "no config". A suppression that matches nothing is reported as a
warning. The MCP server applies the same file the same way, and both name it in `scan.config`.

## The other surfaces

The CLI, the MCP server and the skills' scan step all run the same engine and produce the same
versioned findings schema ([`schemas/`](schemas/)).

- **MCP server** (`@egressa/mcp`): scanning and knowledge base lookups for any MCP client. No write
  tools, no network calls. See [docs/mcp.md](docs/mcp.md).
- **Transfer triage skill** ([skill/egressa](skill/egressa/SKILL.md)): a Claude Code skill that
  works through the findings a scanner cannot judge alone, and researches an unknown vendor from
  primary sources to draft a knowledge base request. It does not research an unresolved host,
  because that answer is in your deployment configuration.
- **Privacy review skill** ([skill/privacy-review](skill/privacy-review/SKILL.md)): a wider review
  the engine does not perform: trackers firing before consent, personal data in logs, session
  replay recording inputs, storage with no expiry, and opt-out signals. Its checklists are applied
  by an agent reading code, so each finding also says whether the source can settle the question at
  all. Anything it cannot settle ends in a question for you rather than an instruction.
- **Write-time hook**, installed with the plugin: when a tracker init, a session-replay init or a
  non-essential storage write is about to be added to a source file, it names the provision that
  pattern engages and asks the question that decides it. It never blocks an edit, stays quiet on
  strictly necessary storage, on tests and fixtures, and on an edit that already carries a consent
  check, and reports each pattern once per file per session. [SECURITY.md](SECURITY.md) describes
  exactly what it reads and writes.

None of these produces a score or a grade.

## Licensing and corrections

Code is MIT-licensed. The vendor knowledge base in [`kb/`](kb/) is licensed separately under
CC-BY-4.0, so anyone, including competing tools, can build on it. It is authored from vendor and
regulator primary sources; see [kb/PROVENANCE.md](kb/PROVENANCE.md). Vendor names are used
nominatively; see [TRADEMARKS.md](TRADEMARKS.md).

Every entry cites its sources and carries a `lastVerified` date. If an entry is wrong, open a
[correction](.github/ISSUE_TEMPLATE/vendor-correction.yml). Under
[kb/KB_POLICY.md](kb/KB_POLICY.md), a correction with a primary source is merged the same day, and
an entry is marked `disputed` as soon as a good-faith objection is raised.

Security reports: [SECURITY.md](SECURITY.md). Release history: [CHANGELOG.md](CHANGELOG.md).
