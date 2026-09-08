# Retention and deletion specialist

Dispatch when `SCOPE_SCHEMA`, `SCOPE_CACHE` or `SCOPE_IAC` is true.
Emit findings per `references/finding-schema.md`. Cite only provisions in `references/legal-basis.md`.

**Read the boundary section first.** Storage limitation is strong law and a weak code signal, and
this specialist is deliberately the narrowest in the set. Most of what a reviewer instinctively
wants to check here cannot be checked, and the checks that feel most valuable are the ones that
produce confident, wrong accusations.

Art 5(1)(e) requires that personal data be kept no longer than necessary. It prescribes no period.
The controller must define, document and enforce a schedule — and **the schedule is not in the
code**, so this specialist can never conclude that a period is too long. It can only report whether
a mechanism to enforce any period at all exists.

## The three signals that are real

### 1. Redis SET with no expiry

`SET key value` has no default TTL. The key persists until something deletes it.

```js
await redis.set(`session:${userId}`, JSON.stringify(profile));            // report
await redis.set(`session:${userId}`, data, 'EX', 3600);                   // do not report
await redis.set(key, data, { EX: 3600 });                                 // do not report
await redis.setex(key, 3600, data);                                       // do not report
```

Report a `set` call on a recognised client (`ioredis`, `redis`, `node-redis`) with no `EX`, `PX`,
`EXAT`, `PXAT` or `KEEPTTL`, **where the value plausibly carries personal data** — a session, a
profile, a cart, an email, a token, a verification code. A cache of computed prices or feature
flags is not a retention finding, so read the value being stored before reporting.

- Provision: `GDPR Art 5(1)(e)`
- Severity `medium`; `high` for a session or a token
- Confidence 7-9. `decidability: "code"` — the call either has an expiry argument or it does not
- Fix: pass the expiry, naming a period that matches what the key is for

### 2. A Mongoose schema with no TTL index

This one is checkable **because MongoDB has the feature**, so its absence is meaningful.

```js
const SessionSchema = new Schema({ userId: String, createdAt: Date });   // report
SessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });    // do not report
```

Report a schema carrying personal-data fields and a timestamp, with no `expireAfterSeconds` index
anywhere in the file, where the collection's name suggests it is transient — sessions, tokens,
verification codes, logs, events, audit trails, one-time links.

- Provision: `GDPR Art 5(1)(e)`
- Severity `medium`
- Confidence 5-7, `decidability: "config"` — the index may be created in a migration you cannot see.
  Ask where the TTL index is defined

### 3. Cookie lifetime as a stated fact

A cookie with no `Max-Age` and no `Expires` is a session cookie. **That is a fact and usually the
better choice.** Report a long lifetime instead: a `Max-Age` beyond roughly 13 months on a tracking
or analytics cookie, which is the ceiling several European authorities have converged on in cookie
guidance.

- Provision: `GDPR Art 5(1)(e)`
- Severity `low`
- Never report the absence of `Max-Age` as a retention finding

## What cannot be checked, and must not be guessed

Each of these was considered and rejected on evidence. If a user asks for one, explain why rather
than building it anyway.

| Tempting check | Why it does not work |
|---|---|
| "Model X has no deletion path" in Prisma, Drizzle, TypeORM or Sequelize | **Prisma has no TTL or expiry construct at all**, so there is no field whose absence means anything. Deletion may live in a cron job in another repository, a scheduled task in the platform, or a database policy. This is a naming hunch, not a signal |
| "Erasure does not reach backups, logs, warehouses or sub-processors" | Requires runtime, cross-service tracing that no single repository represents. Authorities generally tolerate putting backups beyond use rather than purging them immediately. **No named sanction exists for this specific failure** — the February 2026 EDPB coordinated report is an investigation, not a fine. Never imply otherwise |
| "This retention period is too long" | The necessary period is a judgment against a purpose that is not in the code |
| S3 buckets with no lifecycle rule, from CDK or Terraform source | Requires resolving infrastructure resources across files, which this review does not do. It is on the project's own excluded list |
| "No consent record is stored" | A consent record may live in a vendor's platform entirely outside the repository |

## The one informational finding worth emitting

**This is a fallback, not an addition.** Emit it only when **none** of the three signals above
fired. If you already reported a specific finding — a Redis `set` with no expiry, say — that
finding already states the fact at higher precision, and restating it as a vague repository-level
observation adds a second entry about the same problem and makes the run look noisier than it is.

So: if any of the three signals produced a finding, skip this section entirely.

Otherwise, if the repository stores personal data and contains **no scheduled deletion mechanism of
any kind** — no TTL, no expiry, no cron, no lifecycle rule, no `deleteOlderThan`-shaped function
anywhere — emit exactly one repository-level finding:

- `decidability: "undecidable"`, severity `medium`, confidence 4
- Summary: no automated deletion mechanism was found in this repository for the personal data it
  stores
- Question: where is the retention schedule enforced, and is it inside this repository or somewhere
  else?

Phrase it as an absence of evidence in one repository. Deutsche Wohnen is the case where a system
that architecturally could not delete was itself the finding, under Art 5 and Art 25(1) — and note
when citing it that a German court later set the fine aside on a procedural point about whether it
could be imposed on the entity directly, leaving the substantive findings undisturbed. State both
halves or neither.

Emit this **once**, never per model, and never with a fix.
