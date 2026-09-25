---
name: privacy-review
description: Use when reviewing code for privacy and data-protection problems - GDPR or UK GDPR questions, cookies or trackers firing without consent, analytics loaded before a consent gate, personal data kept with no retention period or deletion path, personal data in logs or error reports, session replay recording input fields, Do Not Sell / Global Privacy Control opt-out signals, or a general "review this diff for legal problems" request.
allowed-tools: [Bash, Read, Grep, Glob, Agent, AskUserQuestion, Write, Edit]
---

# Privacy review

A specialist review pass over a diff or a whole repository, looking for the data-protection
problems that are visible in source code. It reports the pattern, the provision that pattern
engages, and the question a human has to answer. It does not assess or certify GDPR compliance.

**Read `references/language-rules.md` before writing anything a user will see.** It is not
boilerplate. The single most damaging thing this review can do is tell a developer they are
breaking the law on the strength of a grep, and the vocabulary table is what prevents that.

Two hard rules, both inherited from the scanner this skill sits beside:

- **Never emit an overall score, grade, or percentage.** Not per-run, not per-category. Reducing a
  data-protection position to a number invites exactly the claim the tool refuses to make, and it
  is on the project's explicit do-not-build list. Report findings and counts. Never a verdict.
- **A wrong finding is worse than no finding.** If the code cannot settle a question, say so and
  ask it. Do not guess and do not soften a guess into a recommendation.

## Step 1 — Scope

Resolve the script first — the skill runs both from a checkout of its own repository and from an
installed location, and the two are different paths:

```bash
for _d in "$HOME/.claude/skills/privacy-review" ".claude/skills/privacy-review" "skill/privacy-review"; do
  [ -x "$_d/scripts/scope.sh" ] && SCOPE="$_d/scripts/scope.sh" && break
done
echo "SCOPE_SCRIPT: ${SCOPE:-not found}"
```

If it resolves to nothing, do not fall back to running the review without gates — say the skill is
installed incompletely and stop. The gates are what keep the review from dispatching every
specialist at every repository and reporting on things it was never asked about.

```bash
bash "$SCOPE"                 # diff against the default base branch
bash "$SCOPE" --base main
bash "$SCOPE" --repo          # whole repository
```

Use `--repo` when the user asks about the codebase rather than a change ("is there anything we
retain by accident?"), and diff mode when they ask about a change ("review this branch"). If the
user did not say, and the branch has a base, review the diff and offer the repo pass afterwards.

The script prints `KEY: value` lines. They are **gates, not findings** — they decide which
specialists to run, and nothing else. Read them, then note out loud which specialists you selected
and which you skipped, so the user can see the coverage they actually got.

One line is different: `SIGNAL_TRACKERS_NO_CONSENT: true` means the project ships tracker code or
tracker dependencies and contains no consent machinery anywhere in the reviewed file set. That is
the least arguable observation this review can make. Carry it into the summary even if no
specialist attaches a line number to it.

## Step 2 — Select specialists

Read the checklist file for each specialist you dispatch. Each lives in
`skill/privacy-review/specialists/`.

| Specialist | File | Dispatch when |
|---|---|---|
| Consent gating | `consent-gating.md` | `SCOPE_TRACKERS` or `SCOPE_TRACKER_CODE` or `SCOPE_CLIENT_STORAGE` is true |
| Retention and deletion | `retention.md` | `SCOPE_SCHEMA` or `SCOPE_CACHE` or `SCOPE_IAC` is true |
| Personal data in logs | `pii-in-logs.md` | `SCOPE_LOGGING` is true |
| Session replay | `session-replay.md` | `SCOPE_SESSION_REPLAY` is true |
| Opt-out signals | `opt-out-signals.md` | `SCOPE_TRACKERS` or `SCOPE_TRACKER_CODE` is true |
| Transfers | `transfers.md` | Always, when a manifest or JS/TS source changed |

**Transfers is not gated.** Its row says "Always" because it does not read any `SCOPE_*` line at
all — a manifest or JS/TS file in scope, established back in Step 1, is the only condition there
is. Nothing later in this step, including the "no gate fires" case below, describes a condition
under which Transfers is skipped; if you find yourself asking whether it still runs, the answer is
always yes.

**Not every gate selects a specialist.** Five are context, passed to specialists to inform severity
and to the summary, but never used to dispatch: `SCOPE_FRONTEND`, `SCOPE_BACKEND`, `SCOPE_CONSENT`,
`SCOPE_OPT_OUT` and `SCOPE_ERASURE`. A true value on any of them is not an unrouted finding and not
a bug.

`SCOPE_OPT_OUT` says whether opt-out handling code exists — a GPC or Do Not Track read, or any
`opt_out`. It does not dispatch the opt-out signals specialist: that checklist covers the preference
signals owed by a business that sells or shares data, and its first rule is to emit nothing when no
advertising or cross-context tracker is present, which is what the tracker gates already test. Pass
it to that specialist when it runs, so it knows whether there is a handler to follow.

`SCOPE_ERASURE` in particular fires on any `delete`-shaped function or the word `GDPR`, so it goes
true on almost any codebase including ones with nothing to report. It is there to tell a specialist
that deletion machinery exists to look at, not to claim anything.

If the user passes `--all`, dispatch every specialist regardless of gates. If they name one
(`--consent`, `--retention`, `--logs`, `--session-replay`, `--opt-out`, `--transfers`), dispatch
only that one.

**A degraded gate is not a false gate.** `scope.sh` can emit a second line for a gate it failed to
evaluate — a crash, a missing dependency, a timeout — in addition to that gate's ordinary
`SCOPE_*: false`:

```
SCOPE_DEGRADED: <GATE_NAME> exit=<n>
```

That `false` was never earned; the helper did not find no match, it did not run to a match at all,
so treating it as a clean result is the exact silent failure this whole step exists to prevent.
Dispatch the specialist that gate would have selected, and say in Step 5 that the gate was
unreliable rather than reporting a clean skip.

If no *gated* specialist is selected — every gate in the table above came back false, and none of
them came back degraded — do not invent work. Say which gates were checked and came back false,
name the blind spots from Step 5, and stop. This check is about the five gated specialists only:
Transfers was already selected by the table's "Always" row, before this paragraph is ever reached,
and stopping here does not undo that.

## Step 3 — Dispatch

Launch every selected specialist in a **single message** with one Agent call each, so they run in
parallel with independent context. `subagent_type: "general-purpose"`. Pass
`run_in_background: false` — all specialists must finish before the merge.

Each specialist prompt contains, in this order:

1. The full text of `references/finding-schema.md` — the output contract.
2. The full text of `references/language-rules.md` — the vocabulary contract.
3. The full text of `references/legal-basis.md` — the only provisions and citations a specialist may
   use. Pass it in full rather than summarising it: it also carries the list of widely repeated
   enforcement claims that did not survive checking, and a specialist that has not seen that list
   will cite them.
4. The specialist's own checklist file.
5. The scope lines from Step 1, verbatim, and the stack from `STACK`.
6. The file list under review, and the command that produced it, so the specialist reads the same
   set you did: in diff mode `git diff $DIFF_BASE HEAD`, in repo mode `git ls-files`.
7. This instruction:

> You are a privacy review specialist. Apply the checklist below to the files under review. Open
> and read every file you report on — never report a finding from a grep result alone. For each
> finding emit one JSON object on its own line, per the schema. Emit `fix` only when
> `decidability` is `code`; otherwise emit `question`. If you find nothing, output `NO FINDINGS`
> and nothing else. Output no preamble, no summary, no commentary.

The transfers specialist is different: it shells out to the existing scanner rather than reading
code itself. Its checklist says how.

## Step 4 — Merge

Collect each specialist's lines. Skip anything that is not valid JSON, and say how many lines you
skipped rather than silently dropping them.

**Deduplicate by `fingerprint`.** Where two specialists report the same fingerprint, keep the
higher `confidence`, mark it confirmed by both, and raise confidence by 1 to a maximum of 10.
Cross-specialist agreement is real evidence: a cookie write flagged by both consent gating and
opt-out signals is more likely to be a genuine finding than either alone.

**Do not merge across `decidability`.** A `code` finding and an `undecidable` finding at the same
line are two different claims, and collapsing them loses the honest one.

Then drop anything below `confidence: 3`. Do not report it, and do not list it in an appendix — a
sub-3 finding is a guess, and an appendix of guesses is still a page of accusations.

## Step 5 — Report

Group by `decidability`, in this order. The grouping is the point: it puts what the tool actually
knows above what it merely suspects, which is the opposite of how a scanner usually sorts.

```
PRIVACY REVIEW — <n> findings across <m> specialists
Mode: <diff against main | whole repository>  ·  Files reviewed: <n>

SETTLED BY THE CODE (<n>)
  [severity] <path>:<line> — <summary>
    Provision: <provision>  ·  Confidence: <n>/10  ·  <specialist>
    Fix: <fix>

DEPENDS ON YOUR DEPLOYMENT (<n>)
  [severity] <path>:<line> — <summary>
    Provision: <provision>  ·  Confidence: <n>/10  ·  <specialist>
    You need to check: <question>

NOT DECIDABLE FROM SOURCE (<n>)
  [severity] <path> — <summary>
    Provision: <provision>  ·  <specialist>
    You need to check: <question>

NOT CHECKED
  <the blind spots, always, even when findings is zero>
```

Sort within each group by severity, then confidence descending.

**The `NOT CHECKED` block is mandatory and is never omitted, least of all on a clean run.** A run
with no findings means the checks that ran found nothing, and saying more than that is the failure
this whole skill is built to avoid. Name at least these, plus anything specific to what you
skipped:

- Anything collected server-side. If the browser calls this project's own backend and the backend
  calls a vendor, none of this sees it.
- Anything configured outside the repository — a vendor dashboard, a tag manager container, a
  consent platform's hosted rules, an environment variable.
- Whether the organisation has a lawful basis, a retention schedule, a processor agreement, or
  records of processing. None of that is in the code, and all of it decides the actual answer.
- Files the analysis skipped: `node_modules`, build output, minified and vendored bundles.
- Specialists that were gated off, by name.
- Any gate that came back degraded, by name. Its specialist was dispatched anyway, so this is not
  a gap in what ran — it is a gap in what is known about *why* it ran, and a reader comparing two
  runs needs to know the selection was made defensively rather than on a real signal.

## Recording an accepted finding

When the user decides a finding is accepted, write it down rather than leaving it to be
rediscovered next week. Draft `.privacy-review.yml` for them:

```yaml
version: 1
accepted:
  - fingerprint: "app/layout.tsx:31:consent"
    category: consent
    reason: "Cookiebot gates this via its own script tag in the CDN config, outside the repo. Verified in the Cookiebot console 2026-09-09. Ticket PRIV-88."
    acceptedBy: "name@example.com"
    expires: 2027-03-01
```

`reason` and `expires` are both required by this skill's own convention, for the same reason the
scanner requires them: an accepted risk that nobody revisits is not accepted, it is forgotten, and
"not applicable" helps nobody in six months. A reason must name what was checked and by whom.

The scanner's own suppressions live in `.egressa.yml` and match on vendor and rule id. These are
separate files today because review findings are keyed by path and category rather than by vendor.
Say so if the user asks why there are two.

## Before you write the summary

Re-read `references/language-rules.md`. Then check your draft against it — specifically, that you
have not written that anything is a breach, that you have attached each provision only where it
genuinely applies, and that every `config` and `undecidable` finding ends in a question rather
than an instruction.
