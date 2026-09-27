# Finding schema

Every specialist emits one JSON object per line and nothing else. No preamble, no summary,
no commentary. If a specialist finds nothing it emits `NO FINDINGS` and stops. The transfers
specialist also emits one `_scanner` line, described at the end of this file: anything it has to
say about what the scanner did goes there, never into prose.

```json
{"severity":"high","confidence":8,"decidability":"code","category":"consent","path":"app/layout.tsx","line":31,"provision":"ePrivacy Directive 2002/58/EC Art 5(3)","citation":"https://...","summary":"...","evidence":"...","fix":"...","fingerprint":"app/layout.tsx:31:consent","specialist":"consent-gating"}
```

Required: `severity`, `confidence`, `decidability`, `category`, `path`, `provision`, `summary`,
`specialist`. Then `fix` **or** `question`, per the rule below, except that a `context` line
carries neither. Optional: `line`, `citation`,
`evidence`, `fingerprint`, `test_stub`.

## severity — legal weight, never legality

`high` · `medium` · `low`. Nothing is `error` and nothing is `critical`.

Severity answers *how much exposure does this create if it is real*, derived from the provision
and the data category. It never answers *is this lawful* — that depends on facts absent from
source code (the controller's legal basis, its retention schedule, its records of processing,
what the user was actually shown). See `language-rules.md`.

| Severity | Means |
|---|---|
| `high` | Special-category or credential data, or a provision with a documented enforcement record at this exact pattern |
| `medium` | Ordinary personal data, provision clearly engaged, remediation is a known pattern |
| `low` | Provision engaged only on assumptions the reviewer must confirm, or hygiene adjacent to a provision |

A `critical` severity is deliberately absent. This tool detects; it does not adjudicate. That
mirrors the engine, where nothing defaults to `error` and CI failure is expressed only through
`--fail-on` and an exit code the user opted into.

## confidence — how the signal was obtained

An integer 1-10, and **orthogonal to severity**. Both are surfaced; do not collapse them. A
`high`/3 finding is a serious provision on a shaky signal, and saying so is the point.

| Range | Obtained from |
|---|---|
| 8-10 | A literal in a file under review, read in full, with the surrounding control flow checked |
| 5-7 | Indirection the reviewer followed but could not close: a wrapper, a config object, a call one module away |
| 3-4 | Presence only — a dependency is declared, an import exists, a name appears |
| 1-2 | Do not emit. Below 3 the finding is a guess |

## decidability — the honesty valve

The field with no equivalent in an ordinary code review, and the reason this schema exists.

| Value | Means | Output requirement |
|---|---|---|
| `code` | The source alone settles it. The pattern is present and its consequence follows from the code | `fix` required |
| `config` | The code is consistent with more than one deployment reality, and only some of them engage the provision. Which one is true lives in a dashboard, an env var, or a signed agreement | `question` required, `fix` omitted |
| `undecidable` | No amount of source reading settles it. It depends on a retention schedule, a legal basis, or what a human was shown | `question` required, `fix` omitted |
| `context` | Not a problem to act on: a fact the reader needs beside the findings. Only the transfers specialist may use it, and only for `transfer/eu-processing` and `transfer/adequate-country-egress` | neither `fix` nor `question` |

`context` exists because the alternative was a `code` line with a `fix` saying there was nothing
to fix, rendered under "settled by the code" as though it were a problem. A transfer to an adequate
country is still a third-country transfer, so it is reported, but as context rather than as a
finding.

**Never emit a `fix` for a `config` or `undecidable` finding.** A remediation instruction on a
question you cannot answer is how a privacy tool produces a false accusation, and a false
accusation is worse than silence — the same rule that governs host resolution in the engine,
where an unresolved authority emits the variable name and never a guess.

## question — required when decidability is not `code`

One sentence, answerable by the developer without a lawyer, naming the specific thing to check.

- Good: "Which PostHog region is this project's `POSTHOG_HOST` pointing at in production?"
- Good: "Does the `users` table have a retention period defined anywhere outside the code?"
- Bad: "Is this lawful?" — not answerable from source code, and not this tool's question to ask.

## provision and citation

`provision` names the instrument and the article or section, precisely enough to look up:
`GDPR Art 5(1)(e)`, `ePrivacy Directive 2002/58/EC Art 5(3)`, `CPRA §1798.135`, `UK PECR reg 6`.

`citation` is a URL to a primary source — the instrument, or a regulator's own guidance or
decision. Never a blog post, never a compliance vendor's summary page. Omit the field rather
than cite something weak.

Both come from `references/legal-basis.md` and nowhere else. A vendor's own documents are not a
citation, even when the scanner supplies them: a DPA page, a sub-processor list or an EU-region
page (`dpaUrl`, `subprocessorsUrl`, `euRegion.docUrl`) may appear in `evidence` or in a `question`,
never in `citation`. A URL the scanner output does not carry, such as a Data Privacy Framework
participant listing recalled from memory, is not used at all.

Do not name a provision the finding does not actually engage. Attaching `Art 5(1)(e)` to a
missing `SameSite` flag is the kind of overreach that discredits every other finding in the run.

## fingerprint

`{path}:{line}:{category}`, or `{path}:{category}` where there is no line. The orchestrator
groups by fingerprint to merge duplicates across specialists.

## test_stub

Include only when a test could genuinely catch the pattern in CI — a consent gate, an opt-out
header, a cookie flag, a masking config. Use the detected framework. Omit it for anything
`undecidable`: a test cannot assert a retention schedule exists.

## `_scanner` — the transfers specialist's accounting line

The transfers specialist maps scanner findings into this schema, and some do not map one to one:
two unresolved call sites become one line, a finding is folded into another's summary, a
suppressed finding is left out. Each such choice is recorded here, so a reader can see that every
scanner finding was accounted for. Emit exactly one, after the findings, even with `NO FINDINGS`:

```json
{"_scanner":{"findings":9,"emitted":5,"context":1,"merged":[{"into":"src/mail.ts:10:transfer","count":2}],"dropped":[{"ruleId":"transfer/third-country-egress","vendor":"stripe","reason":"suppressed"}],"engine":"oxc","unmatched":{"hosts":2,"packages":26},"errors":["requirements.txt: compiled without `# via` annotations …"],"notChecked":["server-side proxying"]}}
```

- `findings` is the length of the scanner's `findings` array, suppressed findings and
  `config/expired-suppression` notes included.
- `emitted` counts the finding lines that each stand for one scanner finding, and `context` the
  context lines, which also stand for one each.
- `merged` lists each finding line that stands for more than one scanner finding, by the line's
  fingerprint, with `count` the scanner findings it stands for. Such a line is not in `emitted`.
- `dropped` lists each scanner finding with no line of its own, and why. A suppressed finding is
  dropped with the reason `suppressed`.
- `engine` is `scan.engine.callsite`. `unmatched` counts the scanner's `unmatched` hosts and
  packages. `errors` carries the scanner's own `errors` messages. `notChecked` names blind spots.

The counts must add up: `emitted + context + merged + dropped == findings`, where `merged` is the
sum of the `count`s and `dropped` the number of entries.
