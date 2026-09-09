# Limitations

What Egressa cannot see. Every entry here has a corresponding failing-by-design case in
`packages/core/src/callsites/golden.test.ts`, so these are an executable contract rather than a
disclaimer. If a change makes one of them resolve, the test fails and the limitation must be lifted
deliberately.

A guiding principle runs through all of it: **a wrong host is worse than no host.** An unresolved
destination produces a note asking a human to look. A confidently wrong one produces a false vendor
attribution that someone may act on.

## Structural — no static scanner can close these

### Server-side proxying

Your frontend calls your own backend; your backend calls the vendor. If that backend is not in the
scanned repository, the transfer is invisible.

```js
await fetch('/api/track', { method: 'POST', body });  // reported: nothing
```

This is the largest gap in the tool and the first one a skeptical reader will find. It is stated in
the README rather than buried here.

### Runtime-configured destinations

A host that arrives from an environment variable, a feature flag, a config service, or a secret
manager is not knowable from source.

```js
fetch(process.env.ANALYTICS_URL);        // transfer/unresolved-egress, names ANALYTICS_URL
fetch(`https://${region}.example.com`);  // transfer/unresolved-egress, authority interpolated
```

Egressa names the variable and the location. It never guesses the host.

### Vendors absent from the knowledge base

Reported as `transfer/unknown-vendor-egress`. The knowledge base is a curated seed set, not a
census, and no jurisdiction can be reported for a vendor that has no entry. The `unmatched` block
in JSON output lists these, and it is the project's only recall signal — there is no telemetry.

## Analysis scope — deliberate v1 boundaries

### Cross-module constants

Analysis is single-file. A constant imported from another module does not resolve.

```js
import { API_BASE } from './config';
fetch(API_BASE);   // transfer/unresolved-egress
```

Following imports means resolving the module graph, which wants `node_modules` on disk. The
offline, works-on-a-fresh-clone property is worth more than the recall. A whole-program constant
table keyed on resolved relative specifiers is the planned fix.

### Reassignment and computed access

`let` reassignment is not tracked, and neither is computed member access, array `join`, `eval`, or a
dynamically `import()`ed SDK.

```js
let base = 'https://api.stripe.com';
base = pickHost();
fetch(base);       // resolves to api.stripe.com -- may be wrong
```

This is the one case in the golden table where the analyzer produces a **possibly incorrect**
answer rather than declining. It is recorded there explicitly so the behaviour is visible.

### Constant chains deeper than three steps

Bounded at `MAX_DEPTH = 3`. Deeper chains report as unresolved rather than being followed.

### Minified, bundled and vendored code

Skipped entirely: `*.min.js`, `*.bundle.js`, `dist/`, `build/`, `.next/`, `vendor/`. Matching
inside generated output produces an annotation on a line nobody can act on; the fix belongs in the
source that generated it.

### Non-JavaScript surfaces

Out of scope in v1: HTML `<script src>` tags, Google Tag Manager containers, Content-Security-Policy
headers, `next.config.js` remote domains, native mobile code, and infrastructure configuration. A
tag manager in particular can load vendors that appear nowhere in your source.

### The native parser can be absent

Call-site analysis needs `oxc-parser`, a native addon that ships a platform-specific binary through
optional dependencies. On a platform with no matching prebuild it cannot load, and the scan then
reads dependency manifests only. That is reported, not hidden: `scan.engine.callsite` is
`unavailable`, `scan.engine.degraded` is `true`, and human output says call-site analysis was
unavailable.

**A degraded scan is much weaker than a full one**, and not proportionally. A vendor called by URL
without its SDK declared as a dependency is invisible in this mode — which is precisely the case
call-site analysis exists to catch. Treat a clean degraded scan as almost no evidence.

There is deliberately **no regex fallback**. A second, weaker analyser would produce findings whose
provenance nobody could reason about, and the confidence model exists to prevent exactly that.
`engine.degraded` is the honest alternative. `packages/core/src/degraded.test.ts` forces the binding
failure and asserts the output stays schema-valid.

The copy of the CLI bundled inside `skill/privacy-review/bin/` does not ship the native binding, so
it normally runs in this mode. `scan-transfers.sh` prefers a real build for that reason.

### Ecosystems other than npm

v1 parses npm manifests and JavaScript/TypeScript sources only. The knowledge base is keyed by
vendor identity with per-ecosystem package aliases, so adding Python is a manifest parser and an
alias list rather than a redesign.

## What a finding does not establish

Even a high-confidence, resolved call site only shows that code *references* a vendor. It does not
show that the code runs, that personal data flows through it, that the data is personal, or that
sending it is unlawful. See [CLAIMS.md](CLAIMS.md).

## The review skills have no golden table

Everything above is about the engine, and every limitation above has a corresponding
failing-by-design case in `packages/core/src/callsites/golden.test.ts`. That is what makes those
limits a contract rather than a list of good intentions.

`skill/privacy-review/` works differently. It is a set of checklists an agent applies by reading
code, so there is no parser whose output a table can pin down, and no equivalent contract. Its
limits live in three places instead:

- `skill/privacy-review/references/legal-basis.md` — the only provisions and citations a specialist
  may use, plus the two checks that are deliberately not built and why, plus a table of widely
  repeated enforcement claims that did not survive checking against the authority's own decision.
- `skill/privacy-review/specialists/retention.md` — the narrowest checklist in the set, and the one
  that lists what cannot be checked at more length than what can.
- Each checklist's own **Do not report** section, which is where the false-positive traps are
  recorded — the strict-necessity exemption for session and CSRF cookies being the largest.

What the two surfaces share is the third axis on every review finding: whether the source settles
the question at all. Anything that does not ends in a question rather than a fix, which is the same
rule that makes the engine name an unresolved variable instead of guessing a host.
