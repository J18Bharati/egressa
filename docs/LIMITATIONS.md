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

A stable module-scope string constant is folded into the text around it first, across template
literals and `+`, and the authority is read once from the folded text. So `` `${BASE}/watch` `` and
`BASE + '/v1'` resolve, and `BASE + '.example.net/x'` resolves to the host it actually names rather
than to the vendor `BASE` alone would suggest. What does **not** resolve is a base whose authority
is left open, followed by something unknown:

```js
const BASE = 'https://api.stripe.com';
fetch(BASE + path);        // transfer/unresolved-egress: nothing proves `path` starts with '/'
fetch(BASE + '/' + path);  // api.stripe.com
```

This is a deliberate false negative. Until the fold existed the first line resolved to
`api.stripe.com` at high confidence, which was right only as long as `path` began with a delimiter;
`BASE + '.attacker.example/x'` resolved to the same vendor. A base written with its trailing path,
or a path added as a literal, resolves.

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

Only module-scope declarations are collected, and only those above the call. These forms count as a
declaration -- a parameter (destructured, defaulted or rest), a `catch` clause, a destructuring
declaration, a function, class or import name, and TypeScript `enum`, `namespace` and `import X =`
-- and these as a reassignment: pattern assignment, a `for...in`/`for...of` target, `++`, `--`, and
a write through `globalThis`, `window`, `self` or `global`. A `with` statement or a direct `eval`
anywhere in a file -- parenthesised or type-asserted -- makes every name declared in it
unresolvable, since either can rebind any of them. Type assertions and parentheses on an
assignment target are seen through: `(B as any) += x` reassigns `B`.

One boundary is deliberate. A top-level `var` in a classic, non-module browser script is also a
property of the global object, and can be rebound in ways this does not follow: indirect `eval`,
`new Function`, a write through an alias of `globalThis`, `Object.defineProperty` or
`Object.assign` on it. None of these reach an ES module's or a CommonJS module's scope, which is
where nearly all the code this tool reads declares its constants. So
`function client({ apiUrl }) { fetch(`${apiUrl}/v1`) }` beside a module-scope `apiUrl` is refused
rather than resolved to the module's value. The cost is recall on files that reuse a name; the
benefit is that no shadowed or stale binding can produce a confident wrong host.

Two more rules keep a resolved host the true one. A URL resolves only when its scheme starts the
string: `fetch('/proxy?u=https://api.stripe.com/v1')` goes to the app's own origin, so it is not a
transfer to Stripe. And for `http`, `https`, `ws`, `wss` and `ftp` the authority is read by
the WHATWG URL parser itself once the folded text has closed it: a backslash ends it, so
`https://api.stripe.com\@evil.example/x` is Stripe's host; percent-escapes, full-width dots, IPv6
literals, embedded tabs and leading whitespace are handled as `fetch` handles them; and an authority
the parser rejects reports nothing, because `fetch` would throw before sending. Computed member access, array `join`, `eval`, and a dynamically `import()`ed SDK are
also untracked and unresolved.

An earlier version of this file said no case in the golden table produced a **possibly incorrect**
answer rather than declining. It was not true when written: `B + '.attacker.example/x'` resolved to
the vendor `B` named, and no row covered it, and a request on an axios client reported the client's
base URL even when the request URL was absolute. The golden table now pins the true host for both.
Two kinds of possibly incorrect answer are kept on purpose, each documented with the assumption
it rests on: an axios base URL that configuration the analyzer cannot read might replace, under
"Requests through axios", and an interpolated path in a connection URI, under "Connection URIs".

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

**A construction that a call does consume is a call site, at `high`, reported once.** The demotion
applies to the construction *on its own*, never to a transfer that happens to be written in two
expressions. The analyzer therefore resolves through the forms that hand the constructed object to
the call -- directly, through `.toString()`, `.toJSON()` or `.href`, and through a module-scope
binding:

```js
fetch(new URL('https://api.stripe.com/v1'));                  // callsite, high
fetch(new URL('https://api.stripe.com/v1').toString());       // callsite, high
fetch(new URL('https://api.stripe.com/v1').href);             // callsite, high
const u = new URL('https://api.stripe.com/v1');
fetch(u.toString());                                          // callsite, high -- one finding
const req = new Request('https://api.stripe.com/v1');
await fetch(req);                                             // callsite, high -- one finding
```

Each of those is **one** finding, not two: the construction the call read is recorded as consumed
and the reference it would otherwise have emitted is dropped. That bookkeeping cannot be a skip
during the walk, because through a binding the construction is emitted several statements before
the call that consumes it; the suppression happens once the file is finished.

The recall this recovers is not optional decoration. A resolved third-country call site that is
reported at `medium` disappears from a `--min-confidence high` CI gate, and a scanner that stops
failing a gate it used to fail is worse than one that reports a reference nobody wanted. The golden
table pins the kind, the confidence and the count on every one of these shapes.

What still declines, deliberately:

- **Only `href`, `toString()` and `toJSON()` are read through.** `pathname`, `origin` and
  `searchParams` are parts of a destination, not the destination, and `Request#url` is left out
  because `request.url` on an *inbound* request is the commonest shape in this whole area.
- **A bound construction obeys the same refusal every other binding does.** Module scope only, and
  never a name declared twice or reassigned -- there is no scope chain to say which declaration a
  call reads. A construction inside a function, or one whose name is shadowed, does not resolve.
- **Reading through does not invent an argument the constructor never had.**
  `fetch(new URL(request.url).toString())` reports a call site with **no** host, exactly as
  `fetch(new URL(request.url))` does: the call is real, the destination is not knowable.

Two consequences are deliberate false negatives:

- **A reference emits only on a resolved host.** Where the argument does not resolve, nothing is
  reported at all. A call sink in the same position emits `transfer/unresolved-egress` naming the
  variable; a reference sink stays silent, because "a variable was passed to `new URL()`" is not
  evidence that anything left. So `new URL(request.url)` and `new URL(connectionString)` above
  produce no finding, and neither does `` new URL(`${base}/messages`) `` when `base` is not a
  module-scope string constant. One whose base is such a constant is folded, and resolves.
- **An in-process dispatcher is indistinguishable from a transfer.** Nothing in the source says
  whether `app.handle(new Request(host))` crosses a network. The analyzer reports the weaker claim
  rather than guessing either way, so a genuinely local dispatch still appears as a reference to
  whatever host the literal names. Scope those out with `--exclude` or `.egressaignore` rather than
  expecting the engine to recognise a test. The one exception is a name a standard reserves:
  `localhost` and names under it, `127.x.x.x`, `[::1]`, `example.com`/`.net`/`.org` and the
  `.test`, `.example` and `.invalid` top-level names (RFC 2606, RFC 6761) are not reported as an
  unknown vendor at all, from a call site or a reference, since no third party can hold them. A
  hit a vendor's client already attributed keeps the vendor. Private address ranges are still
  reported: `10.0.0.5` can be a vendor's appliance inside a network.

A consumer that renders a `reference` the way it renders a `callsite` re-creates the whole defect.
The distinction is carried by the type, not by the wording.

### A config object that only looks like a client

An SDK whose default export takes its destination as an option -- `new OpenAI({ baseURL })`,
`new Anthropic({ baseURL })` -- is matched on the option alone, whatever the call is named, because
the default export can be imported under any name. That match also fires on every other call that
happens to carry the same key: a test assertion, a mock expectation, a Playwright page, an in-house
HTTP factory. A field test of 21 public repositories found it reporting `localhost` and test hosts
as call sites at high confidence.

The option is now a call site only when the file imports a module that declares it: an ESM import,
a re-export, `require('x')`, a dynamic `import('x')` or `import x = require('x')`, matching the
module exactly or one of its subpaths (`openai/...`). Otherwise the hit is demoted to a `reference`,
capped at medium, and the vendor attribution is unchanged.

The deliberate consequence: a client built in one file from an SDK imported in another is a
reference, not a call site. The import gate is per file, for the same reason module-scope constants
are: cross-module resolution is out of scope.

### Requests through axios

axios can be given two destinations: a base URL, on the client or in the request config, and the
request URL. It joins them by its own rule (`buildFullPath`, checked against axios 1.12.2): the
request URL when it is absolute -- `scheme://` or protocol-relative `//`, tested on the raw string --
and the base URL when it is relative or when `allowAbsoluteUrls` is `false`. Egressa applies that
rule:

```js
const api = axios.create({ baseURL: 'https://api.stripe.com' });
api.get('/v1/charges');               // api.stripe.com, medium: read through the client binding
api.get('https://evil.example/x');    // evil.example, high: the request URL replaces the base
api.get(' https://evil.example/x');   // api.stripe.com: a leading space is relative to axios
```

Where the request URL could be either, it declines rather than reporting the base URL:

```js
api.get(url);                // unresolved: names url
api.get(`/${path}`);         // unresolved: `path` beginning with '/' makes it protocol-relative
api.get(`users${rest}`);     // unresolved: `rest` could finish a scheme
api.get('//evil.example/x'); // unresolved: the scheme, and so the origin, come from the page
```

`allowAbsoluteUrls` is read only where it is visible, and anything that could set it without being
read makes an absolute request URL decline, since the base may or may not apply: a value other than
a literal `true` or `false`, a config passed by name, a spread or computed key, or a `defaults`
object reached in the file in any way other than through one of its other named keys. So
`Object.assign(api.defaults, ...)`, an alias of the client or of its defaults, and `delete` all
count, while `api.defaults.headers.common.Authorization = token` does not. This applies to every
client in the file, because no scope chain says which one an alias names. A relative request URL is
not affected: whatever `allowAbsoluteUrls` is, axios joins it under the base.

`baseURL` is read the way the object literal evaluates, the last key winning. A spread or computed
key that follows it may replace it, and the base is then unresolved; one that comes before it is
overwritten by it. A `defaults` object's `baseURL` reached in the file, by the same test, makes
every client's base unresolved. A request config's `url` that a spread or computed key could set is
unresolved too. `api.getUri()` and `api.create()` send nothing and are not reported.

What the analyzer does **not** see, and assumes away:

- **A request config passed by name, or spread, with no `baseURL` of its own.**
  `api.get('/x', opts)` and `api.get('/x', { ...opts })` could carry a `baseURL`; it is not read,
  and the client's own base is reported. These are possibly incorrect answers, recorded as such in
  the golden table. Declining would cost every `api.get(path, options)` in a codebase, and a
  per-request base URL hidden in a variable is rare next to that.
- **Interceptors, and defaults written in another module.** A request interceptor can rewrite
  `config.url` or `config.baseURL`, and `axios.defaults` set in a different file changes clients
  created after it, which is the cross-module constant problem above. Neither is followed.
- **Calling the client directly.** `api('/v1')` and `api({ url })` are not reported. A missed call,
  not a wrong host.

### Connection URIs

A `postgres://`, `mongodb://` or `redis://` URI is read by its database client, not by the WHATWG
URL parser, and those clients do not agree with WHATWG or with each other. A URI whose authority is
not its destination is declined rather than parsed per client:

```js
new URL('postgres://user:pw@db.example.com:5432/app');      // db.example.com
new URL('mongodb://a.example.com:27017,b.example.com/');    // nothing: a host list
new URL('postgres://a.example.com:p#w@b.example.com/');      // nothing: libpq reads userinfo past '#'
new URL('postgres://db.example.com/app?host=b.example.com'); // nothing: libpq connects to host=
```

A `hostaddr=` parameter is treated like `host=`, including when its name is percent-encoded or it
follows a `#` inside the query, which libpq does not treat as a delimiter there; so is an
interpolation inside the query or straight after a `?` or `#`, since it could supply either. More
than one `@` in the authority is declined, since MongoDB's parser ends the userinfo at the first,
and so is a `\`, which ioredis reads as `/`, or a character in the host at which ioredis's legacy
`url.parse` ends a hostname (`%`, `;`, a quote, a brace, `|`, `^`, a backtick, `<`, `>`, a space).

An interpolation in the path is not declined: `` `postgres://db.example.com:5432/${name}` ``
resolves, on the assumption that a database name does not carry a query string. A `name` of
`app?host=other.example` would be a wrong host, so this is a possibly incorrect answer, recorded as
the row "a path completed by an interpolation" in `resolve-host.test.ts`. These are `reference` hits today -- no call sink takes a connection URI --
so declining one is silent.

### Constant chains deeper than three steps

Bounded at `MAX_DEPTH = 3`. Deeper chains report as unresolved rather than being followed.

### Symbolic links are not followed

A linked file or directory is not scanned, wherever it points. The scanned repository is untrusted
input and a link is part of it: `pnpm-lock.yaml -> ~/.aws/credentials` used to be read, and the YAML
parser's error quoted its first line into JSON, SARIF and the MCP result; `deps -> /` would walk the
whole filesystem. The glob library offers no middle setting -- it either follows every link or
lists none -- so none are followed, including links that stay inside the repository. Those are
normally a second path to a file that is scanned under its real name; a repository that keeps a
real manifest or source file *only* behind a link is the case this misses.

Every reader also refuses a path whose real location leaves the scan root, or that is not a regular
file (`discovery/read-inside.ts`), which covers `.gitignore` and `.egressaignore`, read outside the
walk. Hard links cannot be told apart from ordinary files and are read; making one to a file outside
the repository needs write access on the scanning machine's filesystem.

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

The copy of the CLI bundled inside `plugin/skills/privacy-review/bin/` does not ship the native binding, so
it normally runs in this mode. `scan-transfers.sh` prefers the build in the checkout the skill lives in
for that reason — never a build in the repository being scanned, which is untrusted input.

### Ecosystems other than npm

Call sites are analysed in JavaScript and TypeScript only. Python is read at the manifest level:
declared dependencies in `requirements*.txt` and `pyproject.toml`, matched against `pypi` aliases.
Three consequences follow. A Python service that calls a vendor by URL, with no SDK declared, is not
detected. `poetry.lock` and `uv.lock` are not read. A `requirements.txt` compiled by pip-compile
or `uv pip compile` is read as a lockfile, split by its `# via` annotations. But output without
annotations looks exactly like a hand-written file, and every package in it is read as declared:
`poetry export`, `pipenv requirements`, and pip-compile or uv run with `--no-header --no-annotate`.
A pip-compile or uv header with no annotations is recognised, and nothing in that file is attributed.
A `# via` parent that is not itself a line in the file is read as the project, because `uv export`
writes no line for a project that is not a package; so a package dropped from the output some other
way than `--no-emit-package` would make its children read as declared. A package that names a parent
the generator lists as excluded, or whose only entries are in no recognised shape, is read as
declared too, with a warning naming it: an excluded name may be a real package or the project
itself, left out to cache a Docker layer, and the file does not say which. So with
`--no-emit-package boto3`, `botocore` is reported as declared, and the warning says why.
The committed real output in `fixtures/lockfiles/requirements/` is uv's; pip-compile's has not been
captured, so its shapes are covered by hand-written cases only. And a
vendor is matched only if its knowledge base entry carries a `pypi` alias — today Twilio and AWS
(`boto3`, `botocore`). Any other vendor's Python SDK lands in `unmatched`, which is the signal to
add one.

## What a finding does not establish

Even a high-confidence, resolved call site only shows that code *references* a vendor. It does not
show that the code runs, that personal data flows through it, that the data is personal, or that
sending it is unlawful. See [CLAIMS.md](CLAIMS.md).

## Windows is untested

CI runs on Linux and macOS only. The first Windows run, on 2026-11-04, failed 64 tests in 8 files:
most spawn `npx`, which on Windows is `npx.cmd` and needs a shell, and the privacy review's
`scope.sh` assumes bash, git, FIFOs and symbolic links behave as they do on a Unix system. Neither
the CLI nor the skills are known to work on Windows; WSL is the supported route there until the
suite passes.

## Repository facts

`.egressa/facts.json` lets a repository record legal facts it checked, and the scan applies them
with their provenance on every surface. The checks are on the file's shape, not on whether it is
true:

- **A fabricated but well-formed citation is accepted.** A fact needs an https source on the right
  domain, a retrieval date that is not in the future, and a status from the closed table. A
  committer can write a participant URL that does not exist, or a status the list never showed,
  and the scan cannot tell: it reaches no network, by design. The defence is visibility, not
  verification. Every finding that depends on the file says so, a loosened one names the rule it
  had without the file, the URL is one click from being checked, and the fact is in the
  repository's diff. A fact that would loosen a finding applies only when whoever runs the scan
  passes `--trust-facts`, which is for a repository they own. Review `.egressa/` like code, and
  give it a CODEOWNERS line.
- **Commit state is not checked.** The file is read from the working tree, whether or not it is
  committed, reviewed or merged. Reading git history would mean believing the repository's `.git`,
  which is hostile input (see the privacy review's file set, below). A CI job that scans a checkout
  of a pull request therefore applies the pull request's own facts file; without `--trust-facts`
  that file can only tighten findings.
- **Whether an agent records facts correctly is not measured.** The skills tell an agent to fetch
  only the task's pages and copy a status verbatim, and a test pins that wording. Whether agents
  follow it is visible only in `egressa facts check`, and there is no telemetry to say more.

## The privacy review's file set

`plugin/skills/privacy-review/scripts/scope.sh` decides which files the privacy review reads, and in a git
repository it asks git. The repository under review is untrusted, and so is its `.git`, which an
archive or shared folder carries. The script blocks the execution and outside-read paths reviews
have found, and reports `DEGRADED` -- which the skill must carry into its report -- whenever it
cannot believe git. What it does not do:

- **Untracked files are not reviewed** while git supplies the file set, in diff mode or
  whole-repository mode. A tracker in a file nobody committed is outside the review, exactly as it
  is outside the repository's history. When the script falls back to `find` -- every `DEGRADED`
  case -- untracked files are reviewed like any other.
- **In whole-repository mode the repository's own index decides the set.** An index that lists
  nothing over a populated tree is caught and the script falls back to `find`; an index that lists
  *some* files is believed, so a `.git` delivered with a crafted index can leave a committed-looking
  file out. Reviewing an archive you do not trust is safest from a fresh clone of its source, or
  from the extracted tree with its `.git` removed, which makes the script list every file.
- **On a machine with no `timeout` command -- stock macOS -- git calls are not bounded.** A `.git`
  holding a FIFO in a place the script does not pre-check (an `include.path` target, a ref, a
  split-index file) can hang the review there. Elsewhere each call is limited to 15 seconds and the
  first timeout ends git's part in the run.
- **A `git worktree` checkout or a submodule checkout always degrades** to whole-repository mode
  over `find`, because its `.git` is a file naming a repository elsewhere, and the script believes
  git only about a directory whose `.git` is its own. So does a clone made with `--shared` or
  `--reference`, which borrows objects through `objects/info/alternates`. Review a diff from a
  plain clone.
- **A run that dies prints no `SCOPE_END: ok` line**, and the skill treats that as a stop. On
  macOS this depends on the script parsing under bash 3.2, which `/bin/bash` is there; a test pins
  the syntax that version needs, and a bash 3.2 run is tested where Docker has the image.
- **A diff is taken only from a repository's top level**, and needs git 2.31 or later.

## The review skills have no golden table

Everything above is about the engine, and every limitation above has a corresponding
failing-by-design case in `packages/core/src/callsites/golden.test.ts`. That is what makes those
limits a contract rather than a list of good intentions.

`plugin/skills/privacy-review/` works differently. It is a set of checklists an agent applies by reading
code, so there is no parser whose output a table can pin down, and no equivalent contract. Its
limits live in three places instead:

- `plugin/skills/privacy-review/references/legal-basis.md` — the only provisions and citations a specialist
  may use, plus the two checks that are deliberately not built and why, plus a table of widely
  repeated enforcement claims that did not survive checking against the authority's own decision.
- `plugin/skills/privacy-review/specialists/retention.md` — the narrowest checklist in the set, and the one
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
`plugin/skills/egressa/references/reconciling-a-cloud-region.md` is how to settle it against a live account.

Not collected at all: files under dot-directories such as `.github/` and `.terraform/`, because the
walker runs with `dot: false`; TOML beyond `fly.toml`; and CDK stack definitions, whose region is an
ordinary constructor argument the call-site analyzer does not yet attribute to a provider.

Five shapes hide a region that is written as a literal, and each is pinned by a case in
`packages/core/src/infrastructure/key-literal.test.ts`:

- **An unterminated heredoc or string in a `.tf` file** hides everything after it. The reader
  carries heredocs, interpolations and strings across lines so that none of them can produce a
  region, and a file that never closes one is read as still inside it.
- **In `fly.toml`, a line inside a multi-line array that begins with `[`** is taken for a table
  header, and `primary_region` is read only above the first table. So a top-level `primary_region`
  written after such an array is not read. Fly's generated configuration does not have this layout.
- **A `provider` block whose header is not the first code on its line**, as in
  `locals { a = 1 } provider "aws" {`, is not read.
- **A `provider` block with an unquoted label**, `provider aws {`, which HCL accepts, is not read.
- **A quoted key in `fly.toml`**, `"primary_region" = "fra"`, which TOML accepts, is not read.
