# Opt-out signals specialist

Dispatch when `SCOPE_TRACKERS` or `SCOPE_TRACKER_CODE` is true.
Emit findings per `references/finding-schema.md`. Take every `provision` and every `citation` from `references/legal-basis.md`.

This check is unusual and that is what makes it good: **the law here demands a machine-readable
signal be read and acted on.** California's regulations name an opt-out preference signal, Colorado's
Attorney General designated Global Privacy Control specifically, and there is a real penalty on the
record — the California AG's $1,200,000 settlement with Sephora on 24 August 2022, expressly for
failing to process GPC opt-outs.

So unlike almost everything else in this review, the question "does this codebase read the signal"
has a clean answer that source code can give.

## Scope gate before you report anything

These obligations attach to a business that **sells or shares** personal information, or processes
it for targeted advertising, and above statutory thresholds. A B2B product with no advertising
trackers is very likely out of scope entirely.

So look first for whether the repository does anything the obligation attaches to: an advertising or
cross-context tracker (Meta Pixel, Google Ads, TikTok, LinkedIn, Snap, a data broker SDK), an
audience or conversion upload, an ad-personalisation call.

If none of that is present, **emit nothing.** Do not report a missing GPC handler in a product that
does not sell or share data. That is the same category error as flagging a CSRF token as needing
consent.

## 1. The signal is never read

When advertising or cross-context trackers are present and neither `navigator.globalPrivacyControl`
nor the `Sec-GPC` header appears anywhere in the repository.

```js
if (navigator.globalPrivacyControl) { disableTracking(); }        // client side
const gpc = req.header('Sec-GPC');                                // server side
if (gpc === '1') { /* treat as an opt-out */ }
```

- Provision: `CPRA, Cal. Code Regs. tit. 11 § 7025`, and `Colorado Privacy Act` where relevant
- Severity `medium`
- Confidence 7-9 for the plain absence — a repository-wide grep settles the presence question
- `decidability: "config"`. Absence from *this* repository is not absence from the product: the
  signal may be handled at a CDN, an edge worker, a consent platform or a tag manager. Ask where
- Question: where is the opt-out preference signal handled, if not in this repository?

Emit this **once** for the repository, not per tracker.

## 2. The signal is read but nothing branches on it

Worse than not reading it, because it looks handled.

```js
const gpc = req.header('Sec-GPC');
logger.info({ gpc });          // read, logged, and then ignored
```

Report where `globalPrivacyControl` or `Sec-GPC` is read and the value does not reach a conditional
that suppresses a tracking, sale, share or ad-personalisation path.

- Severity `medium`, confidence 6-8
- `decidability`: `code` if you can see the value going nowhere in that file; `config` if it is
  passed onward to something you cannot follow

## 3. Do Not Track treated as equivalent

`navigator.doNotTrack` is not the same signal, and no statute in the list makes honouring DNT
mandatory. A project that honours DNT and not GPC has not met the GPC obligation.

Report only as `low` severity context on finding 1. Never as its own finding, and never suggest
removing DNT handling — honouring it is a reasonable thing to do, just not the thing the statute
asks for.

## 4. Confirming recognition to the user

Since 1 January 2026, § 7025(c)(6) also requires that the site show the user their signal was
recognised.

- Provision: `CPRA, Cal. Code Regs. tit. 11 § 7025(c)(6)`
- Severity `low`
- `decidability: "undecidable"` — whether a user sees a confirmation is a UI question, and reading
  the code cannot answer it. Emit only as a question, never with a fix

## Jurisdictional honesty

Do not describe GPC as a GDPR requirement. It is not. The EU route to the same outcome is consent,
handled by the consent-gating specialist, and the two must not be merged into one finding.

Connecticut requires a qualifying universal opt-out mechanism but does not name GPC in statute, so
say "the mechanism Connecticut's law requires, which GPC satisfies in practice" rather than implying
the statute names it.

## Do not report

- A missing GPC handler in a product with no advertising or cross-context trackers
- GPC handling in an EU-only product with no US users, unless the user says otherwise
- The absence of a "Do Not Sell My Personal Information" link. That is a page, not code, and this
  review cannot see whether it exists
