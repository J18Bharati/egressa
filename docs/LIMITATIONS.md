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

Egressa names the variable and the location. It never guesses the host. That applies to call
sinks; a `reference` sink stays silent instead, for the reason below.

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

### Reassignment, shadowing and scope

Binding collection is keyed on the bare name and has no scope chain. Rather than guess which
declaration a call site reads, the analyzer refuses in four situations, each with its own reason
string:

```js
let base = 'https://api.stripe.com';
base = pickHost();
fetch(base);       // "base is reassigned after it is declared"

const B = 'https://one.example.com/x';
fetch(B);          // "B is declared more than once in this file"
function z() { const B = 'https://two.example.com/x'; }

fetch(C);          // "C is used before it is declared"
const C = 'https://later.example.com/x';

function a() { const D = 'https://inner.example.com/x'; }
fetch(D);          // "value of D is not known statically"
```

Only module-scope declarations are collected, and only those above the call. The cost is recall on
files that reuse a name; the benefit is that no shadowed or stale binding can produce a confident
wrong host. Computed member access, array `join`, `eval`, and a dynamically `import()`ed SDK are
also untracked and unresolved.

There is no longer any case in the golden table where the analyzer produces a **possibly incorrect**
answer rather than declining.

### A constructed URL is a reference, not a call

`new URL(...)` and `new Request(...)` parse a string into an object. No socket is opened, and the
same two expressions appear on data arriving *inbound*:

```js
const u = new URL(request.url);              // HTTPS-redirect middleware: nothing left
const url = new URL(connectionString);       // a DSN rewritten to set sslmode
url.searchParams.set('sslmode', 'verify-full');
app.handle(new Request('https://x/openapi')); // an in-process dispatch, not a transfer
```

These carry `kind: "reference"` rather than `kind: "callsite"`, and their confidence is capped at
`medium`. A reference means *a vendor is named here*; it is not evidence that a call happened. The
rows stay in the sink table because the attribution is often right -- a `new URL` on the line
before a `fetch` names the correct vendor -- and deleting them would lose that.

Two consequences are deliberate false negatives:

- **A reference emits only on a resolved host.** Where the argument does not resolve, nothing is
  reported at all. A call sink in the same position emits `transfer/unresolved-egress` naming the
  variable; a reference sink stays silent, because "a variable was passed to `new URL()`" is not
  evidence that anything left. So `new URL(request.url)` and `new URL(connectionString)` above
  produce no finding, and neither does `` new URL(`${API_BASE}/messages`) `` whose base is
  interpolated.
- **An in-process dispatcher is indistinguishable from a transfer.** Nothing in the source says
  whether `app.handle(new Request(host))` crosses a network. The analyzer reports the weaker claim
  rather than guessing either way, so a genuinely local dispatch still appears as a reference to
  whatever host the literal names -- including `localhost`. Scope those out with `--exclude` or
  `.egressaignore` rather than expecting the engine to recognise a test.

A consumer that renders a `reference` the way it renders a `callsite` re-creates the whole defect.
The distinction is carried by the type, not by the wording.

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

### Regions declared outside the repository, and regions that are not literals

A region is read only where it is written down as a string: an SDK client's `region` option, a
Terraform `provider` block, a Serverless `provider.region`, a Vercel `regions` array.

```hcl
provider "aws" { region = "eu-west-1" }      # read
provider "gcp" { region = var.deploy_region } # not read, and not guessed
```

```js
new S3Client({ region: 'us-east-1' });               // read
new S3Client({ region: process.env.AWS_REGION });    // not read
```

The engine also does not default to a provider's documented default. `us-east-1` is an AWS SDK
fallback that applies only when `AWS_REGION`, `AWS_DEFAULT_REGION` and the shared config file are
all absent -- three things a scanner cannot see -- so assuming it would give a confident United
States answer for a repository deployed to Frankfurt.

Where no region is found the finding reports `regionSource:none` and the vendor's full jurisdiction
set, unnarrowed. That is the honest answer, and
`skill/egressa/references/reconciling-a-cloud-region.md` is how to settle it against a live account.

Not collected at all: files under dot-directories such as `.github/` and `.terraform/`, because the
walker runs with `dot: false`; TOML beyond `fly.toml`; and CDK stack definitions, whose region is an
ordinary constructor argument the call-site analyzer does not yet attribute to a provider.
