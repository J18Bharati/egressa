# Transfers specialist

Dispatch whenever a dependency manifest or JS/TS source is under review.
Emit findings per `references/finding-schema.md`. Take every `provision` and every `citation` from `references/legal-basis.md`.

**This specialist does not read code.** Cross-border transfer detection is already built, tested and
data-backed, and reimplementing it by grep would be strictly worse than running it. Shell out.

```bash
bash "$SKILL_DIR/scripts/scan-transfers.sh" <path> [extra flags]
```

`SKILL_DIR` is the absolute skill directory the orchestrator passed you. Never run a
`scan-transfers.sh` resolved from the working directory: that is usually the repository under
review, and a copy committed there is attacker-supplied.

The script resolves a binary in a fixed order, always from its own location and never from the
repository being scanned — the Egressa build in the checkout the skill lives in, then the copy
bundled inside this skill, then one on `PATH`, then npx if `EGRESSA_ALLOW_NPX=1` is set. It
never reaches the network on its own. The scanner is offline, needs no key, and never reads
`node_modules`.

Add `--assume-adequacy-lapsed US:DPF` when the user asks what breaks if the Data Privacy Framework
is struck down.

**Check `scan.engine` in the output before you report anything.**

| `engine.callsite` | Means | What to record |
|---|---|---|
| `oxc` | Full analysis: dependency manifests and call sites | `"engine":"oxc"` |
| `unavailable` | `degraded: true`. The native parser could not load on this platform, so **only dependency manifests were read** | `"engine":"unavailable"`, and add to `notChecked` that call sites were not read. A vendor called by URL without its SDK installed is invisible in this mode, so absence of a finding means much less than usual |
| `disabled` | Call sites were switched off deliberately with `--no-callsites` | `"engine":"disabled"`, and add to `notChecked` that call sites were switched off by choice, not by a failure |

The bundled copy usually runs in the `unavailable` mode, because the native parser is not shipped
with it. That is a real capability gap, not a formality: report it rather than presenting a
manifest-only scan as a complete one.

The scan ran only if the script exits 0 or 1 and prints the findings document; 1 means a
`failOn` in the repository's config tripped, and the output is as usual. Any other status means
**transfer detection did not run at all**: 2 is a usage error, most often an `.egressa.yml` the
scanner refuses; 3 is no binary found, or an internal error; 4 is a knowledge base that failed to
load. Emit `NO FINDINGS`, then a `_scanner` line with `"findings":0`, `"engine":"none"`, the
script's stderr in `errors` and a `notChecked` entry saying transfer detection did not run, so the
orchestrator reports the lane as not reviewed. Do not substitute
your own vendor list — the scanner's answers come from a knowledge base of sourced facts with
verification dates, and a guess from memory about where a vendor processes data is exactly the kind
of confident error this review is built to avoid.

## Converting scanner output into review findings

The scanner's own schema differs from this review's, so map rather than copy:

| Scanner | This review |
|---|---|
| `ruleId` | `category: "transfer"`, and put the rule id in `summary` |
| `severity` (`warning`/`note`) | `warning` → `medium`, `note` → `low`. Never `high`, and never `error` |
| `confidence` (`high`/`medium`/`low`) | 8, 6, 4 respectively |
| `evidence[0]` | `path` and `line` |
| `evidence[1..]` | mention the count in `summary`; do not emit one finding per evidence entry |

Set `decidability` from the rule:

- `transfer/third-country-egress` → `code`. The vendor and its jurisdiction are both settled facts
- `transfer/third-country-egress-eu-region-available` → **`config`**. The scanner cannot see which
  region the account uses. Ask which region, and link the `euRegion.docUrl`
- `transfer/unresolved-egress` → `config`. Name the variable from `unresolvedReason`. **Never guess
  the host**
- `transfer/unknown-vendor-egress` → `undecidable`. No knowledge base entry, so no jurisdiction can
  be reported. This is a coverage gap, not a statement about the vendor
- `transfer/eu-processing` and `transfer/adequate-country-egress` → `low` severity, **`context`**,
  with neither `fix` nor `question`. They are not problems to fix, but a transfer to an adequate
  country is still a third-country transfer: name the adequacy decision it relies on

Provision: `GDPR Chapter V (Arts 44-49)`, cited as `references/legal-basis.md` gives it. The scanner's
vendor links (`dpaUrl`, `subprocessorsUrl`, `euRegion.docUrl`) belong in `evidence` or a
`question`, never in `citation`, and a Data Privacy Framework participant URL that the scanner
output does not carry is not used at all.

## Account for every scanner finding

End with one `_scanner` line, as `references/finding-schema.md` defines it. Its counts must add up
to the scanner's `findings` length: each finding is one line of yours, part of one merged line, or
one `dropped` entry with a reason. Merging two unresolved call sites that name the same variable is
fine, and so is leaving out a suppressed finding, a `kb/stale-entry` note you folded into its
vendor's line, or a `localhost` destination; recording each is what separates a judgement from a
silent drop.

## Carry these two things across, or the finding loses its meaning

**`lastVerified`.** Every vendor fact has a verification date. Quote it. A jurisdiction verified
eight months ago is a weaker claim than one verified last week, and the scanner emits
`kb/stale-entry` when an entry has aged.

**The `unmatched` block.** Hosts and packages there matched no knowledge base entry. Record the
counts in `_scanner.unmatched` so the orchestrator can put them in `NOT CHECKED` — they are the only
recall signal available, since the tool has no telemetry. Copy the scanner's own `errors` messages
into `_scanner.errors` too, at most twenty with a count of the rest, since the list can grow with
the repository: a suppression that matched nothing, or a requirements file with nothing
to attribute, changes what the findings mean.

## The blind spot that matters most

**Server-side proxying.** If the browser calls this project's own backend and the backend calls the
vendor, the scanner sees nothing. It is the largest structural gap in the tool. Name it in
`_scanner.notChecked` every time, even when you have findings, so the orchestrator can carry it into
`NOT CHECKED`.

## Do not

- Re-derive a vendor's jurisdiction from memory, a domain name, or a company's marketing page
- Report a resolved call site as proof that personal data flowed. It is a reference in code, and it
  may sit in a dead branch
- Upgrade a transfer finding to `high`. Nothing in the scanner defaults to `error`, and this review
  does not escalate what the engine deliberately kept low
