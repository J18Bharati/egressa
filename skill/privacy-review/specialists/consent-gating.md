# Consent gating specialist

Dispatch when `SCOPE_TRACKERS`, `SCOPE_TRACKER_CODE` or `SCOPE_CLIENT_STORAGE` is true.
Emit findings per `references/finding-schema.md`. Take every `provision` and every `citation` from `references/legal-basis.md`.

This is the strongest ground of any check in this review. It is also the one with the largest
false-positive trap, described in full below. Read that section before you emit anything.

## Read this first: the strict-necessity exemption

Art 5(3) ePrivacy contains its own exemption. Storage or access **strictly necessary to provide a
service the user explicitly requested** needs no consent. In ordinary code that covers:

- session and authentication cookies
- CSRF and anti-forgery tokens
- load-balancer or shard affinity cookies
- a shopping basket
- a language, currency, theme or accessibility preference the user themselves set
- consent state itself — the record of what the user chose

**Do not report any of these.** A review that flags a CSRF token as needing consent is wrong on the
text of the provision, and it discredits every other finding in the run. When a storage write's
purpose is genuinely unclear from the name and the surrounding code, that is a `config` finding with
a question, not a `code` finding with a fix.

## 1. Tracker initialised during module evaluation

The core check. A tracker that runs when the module is evaluated cannot have been gated on a choice
the user had not yet made.

Init calls to look for: `analytics.load(`, `posthog.init(`, `mixpanel.init(`, `amplitude.init(`,
`amplitude.getInstance().init(`, `gtag('config'`, `fbq('init'`, `ttq.load(`, `snaptr('init'`,
`clarity(`, `hj(`, `LogRocket.init(`, `FS.identify(`, `Smartlook.init(`, `heap.load(`,
`_linkedin_partner_id`, plus any `<script src>` for a tracker host in a template or HTML file.

**The discriminator is structural, not textual.** Walk up from the call to the nearest enclosing
function. Report it only when the call is reachable from module evaluation: at module top level, in
a top-level IIFE, or in a function that is itself called at top level. If the call sits inside a
function that is only ever passed to an event listener, a route handler, an effect hook or a consent
callback, it is not an import-time init and you must not report it as one.

True positive — top-level and unconditional:

```js
import mixpanel from 'mixpanel-browser';
mixpanel.init('TOKEN', { autocapture: true });   // runs on import
```

Near miss you must not report — identical call, properly gated:

```js
function loadAnalyticsIfConsented() {
  if (hasConsent('analytics')) {
    analytics.load({ writeKey: 'abc123' });
  }
}
window.addEventListener('cmp:consent-changed', loadAnalyticsIfConsented);
```

Third case — gated on a value you cannot resolve:

```js
if (window.__consentGranted) {
  posthog.init(KEY);
}
```

A gate exists but its value is set somewhere you cannot see. This is `decidability: "config"`,
confidence 4-6, and the question is where `__consentGranted` is set and whether it can be true
before the user has chosen. **Do not report this as ungated.** Declining to resolve is the correct
answer, exactly as the scanner names an unresolved variable rather than guessing a host.

- Provision: `ePrivacy Directive 2002/58/EC Art 5(3)`
- Severity, by what the tracker is for. Classify from this table rather than judging per vendor,
  so that two runs over the same line agree:

  | Kind | Examples | Severity |
  |---|---|---|
  | Advertising, cross-site or audience building | Meta Pixel, Google Ads, TikTok, LinkedIn, Snap, any data broker SDK | `high` |
  | Session replay or behavioural recording | LogRocket, FullStory, Hotjar, Clarity, Smartlook | `high` — it records what a person typed, so treat it as the advertising tier even though it is first-party |
  | First-party product analytics | Mixpanel, Amplitude, PostHog, Heap, Plausible | `medium` |
  | Error and performance monitoring | Sentry, Datadog, New Relic, Bugsnag | `medium`, and `low` where the init sets no user context |

  A vendor that spans two rows takes the higher severity. If a vendor is in none of them, say which
  row you placed it in and why, so the choice is visible rather than silent.
- Fix, only when `code`: move the init behind the consent check that already exists in the project,
  naming the file where that check lives. If the project has no consent check anywhere, say so and
  do not invent an API for it.

## 2. Google Consent Mode v2 missing its default

Consent Mode requires a `default` call, with everything denied, **before** the tag loads, so that
the tag knows to hold. A `config` or tracker load with no preceding `default` call means the tag
starts in a granted state.

Correct shape:

```js
gtag('consent', 'default', {
  ad_storage: 'denied', ad_user_data: 'denied',
  ad_personalization: 'denied', analytics_storage: 'denied',
  wait_for_update: 500,
});
// tag snippet loads here
gtag('consent', 'update', { analytics_storage: 'granted' });  // only after the user chooses
```

Report when a `gtag('config'` or a GTM snippet appears with no `gtag('consent', 'default'` earlier
in source order in the same file or in a file it clearly loads first. Confidence drops to 5 or below
when the ordering spans files, because you cannot see load order — say that in the summary.

- Provision: `ePrivacy Directive 2002/58/EC Art 5(3)`
- Severity: `high`. Advertising storage is the category regulators have fined.

## 3. IAB TCF consulted synchronously

TCF loads asynchronously. Correct use registers a listener and acts on the callback:

```js
__tcfapi('addEventListener', 2, (tcData, success) => {
  if (success && (tcData.eventStatus === 'tcloaded' || tcData.eventStatus === 'useractioncomplete')) {
    // vendor code here
  }
});
```

Report a tracker init that follows a one-shot `__tcfapi('getTCData', ...)` whose result is cached
and never re-checked. It reads as a consent check but can act on stale or incomplete state.

- Provision: `ePrivacy Directive 2002/58/EC Art 5(3)`
- Severity: `medium`. Confidence rarely above 6 — this is a timing argument, so say so.

## 4. Client storage write with no gate in scope

`document.cookie =`, `localStorage.setItem`, `sessionStorage.setItem`, `indexedDB`, a server
`res.cookie(` or a `Set-Cookie` header.

First apply the exemption list at the top of this file. If the name and surrounding code identify
the write as strictly necessary, skip it entirely.

Otherwise: report only when the write is not lexically inside a branch that tests something
consent-shaped (`hasConsent`, `consentGranted`, `analytics_storage`, a CMP object). This is a
**name-matching heuristic, not a reachability proof** — a gate three frames up in a caller is
invisible to you. So:

- `decidability`: `config`, never `code`
- `confidence`: 4-6
- `question`: name the write and ask which purpose it serves and whether a consent gate precedes it
  at runtime

```js
localStorage.setItem('utm_source', params.get('utm_source'));  // report: attribution, not necessary
document.cookie = `csrf_token=${token}; Secure; SameSite=Strict; Path=/`;  // do not report
```

- Provision: `ePrivacy Directive 2002/58/EC Art 5(3)`
- Severity: `medium`

## 5. Cookie attributes

A `document.cookie` or `Set-Cookie` write missing `Secure`, or missing `SameSite`, or a
session-bearing cookie readable from JavaScript that could have been `HttpOnly`.

**This is a different provision and you must not conflate it with consent.** It engages Art 32
security of processing, not Art 5(3). File it as its own finding with its own provision.

Absence of both `Max-Age` and `Expires` makes it a session cookie. That is a **fact, not a problem**
— a session cookie is often the better choice. Report it only as context on another finding, never
as a finding of its own.

- Provision: `GDPR Art 32`
- Severity: `low`, or `medium` where the cookie carries a session or token
- `decidability`: `code`. The attributes are in the string, so this one you can settle

## 6. A default that is on

Art 25(2) requires defaults to process only what is necessary, without the user having to act. The
checkable form is a literal default value: a marketing, tracking, sharing, profiling or
personalisation field whose default is on.

```ts
marketingOptIn: boolean = true;                        // report
@Column({ default: true }) shareWithPartners: boolean; // report
<input type="checkbox" name="newsletter" checked />    // report
trackingEnabled = false;                               // do not report
```

Only report a literal default in source: a field default, a column default, a default parameter, or
a pre-checked input. Do not infer a default from a variable name alone.

- Provision: `GDPR Art 25(2)`
- Severity: `medium`
- `decidability`: `code`

## Do not report

- Any storage write covered by the strict-necessity exemption
- A tracker init inside a consent callback, an effect hook or an event handler
- "This project has no consent banner" as a per-file finding. It is one repository-level
  observation, and the orchestrator already has it from `SIGNAL_TRACKERS_NO_CONSENT`
- Anything about the wording, prominence or design of a consent banner. Whether a banner is valid
  turns on what the user saw, which is not in the code
