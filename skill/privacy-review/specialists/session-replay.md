# Session replay specialist

Dispatch when `SCOPE_SESSION_REPLAY` is true.
Emit findings per `references/finding-schema.md`. Cite only provisions in `references/legal-basis.md`.

Session replay records what a person typed and saw. The recording itself is ordinary product
practice; what matters in code is whether text inputs are masked, and most vendors already mask
them by default. **Precision here is easy and cheap, so there is no excuse for a vague finding.**

## The default masking table — verified against vendor documentation

| Tool | Text inputs masked by default | So report |
|---|---|---|
| **LogRocket** | **No.** Only `type="password"` is excluded. `dom.inputSanitizer` defaults to `false` | An init with no `inputSanitizer: true` |
| FullStory | Yes, under Private by Default | Only an explicit unmask or an exclusion of that setting |
| Hotjar | Yes. User input suppressed client-side | Only an explicit unmask |
| Microsoft Clarity | Yes, in all three modes, and it cannot be turned off for inputs | Nothing about masking. Do not report it |
| Smartlook | Yes. Forms are not recorded unless `{ forms: true }` is passed | An explicit `forms: true` |
| PostHog | Yes. `maskAllInputs` defaults to `true` | An explicit `maskAllInputs: false` |
| Sentry Replay | Yes. `maskAllText`, `maskAllInputs` and `blockAllMedia` all default to `true` ([integration source](https://github.com/getsentry/sentry-javascript/blob/develop/packages/replay-internal/src/integration.ts), checked 2026-09-25) | An explicit `maskAllText: false` or `maskAllInputs: false`, or an unmask selector |
| Datadog RUM | Yes. `defaultPrivacyLevel` is `mask` when not set ([privacy options](https://docs.datadoghq.com/real_user_monitoring/session_replay/browser/privacy_options/), checked 2026-09-25) | An explicit `defaultPrivacyLevel: 'allow'` |

**LogRocket is the outlier and the main finding this specialist exists to produce.**

```js
LogRocket.init('app/id');                                  // report: text inputs not masked
LogRocket.init('app/id', { dom: { inputSanitizer: true } }); // do not report
```

Read the second argument's object literal for `dom.inputSanitizer`. If the config is spread from a
variable or built dynamically, you cannot see the value: that is `decidability: "config"` with a
question, not a `code` finding.

- Provision: `ePrivacy Directive 2002/58/EC Art 5(3)`
- Severity: `high` where the app has authenticated forms, payment fields or anything health, legal
  or financial; `medium` on a marketing site
- `decidability`: `code` when the init and its literal config are both visible
- Fix: pass the masking option, quoting the exact option name for that vendor

## Masking switched off explicitly

Any of `maskAllInputs: false`, `maskAllText: false` on Sentry, `defaultPrivacyLevel: 'allow'` on
Datadog, `maskTextSelector: 'none'`, `forms: true` on Smartlook, a LogRocket `inputSanitizer: false`, or a per-element unmask attribute on a field that carries
personal data.

Severity `high`. This is a deliberate choice, so the finding is about whether it was intended and
recorded, not whether the vendor default is safe.

## Recording reaching a field that should never be recorded

Look for a replay tool active on a route or component that renders: a password, a payment card, a
national identifier, a date of birth, a health or diagnosis field, or a free-text field where a
person could type anything about themselves.

**"Active on" when the init is framework-global.** An init in a Next.js root `layout.tsx`, a Nuxt
plugin, a Remix root route, an Angular `AppModule` or a top-level `App.tsx` mounts on *every* route
by framework convention, including sign-in and checkout. That widens the blast radius, and it is
worth saying so — but a global mount is **not by itself** evidence that a sensitive field is
recorded. You still need to find the field.

So handle the two cases separately:

- You found the tool globally mounted **and** a sensitive field rendered somewhere in the reviewed
  files: report it, naming both paths.
- You found the global mount but **no** sensitive field in the files under review: do not report a
  finding. Note in the masking finding's `evidence` that the mount is framework-global, and leave the
  question of which routes render sensitive fields to the orchestrator's `NOT CHECKED` block. A
  server handler reading `req.body.password` is evidence that a password exists in the product; it is
  not evidence that a *recorded form field* does, because the form may live in another repository.

Special-category data under Art 9 raises the stakes materially, and a free-text box is where it
arrives without anyone planning it.

- Provision: `ePrivacy Directive 2002/58/EC Art 5(3)`, and `GDPR Art 9` where the field is
  special-category
- `decidability`: usually `config` — you can see the field and the tool, but not whether the
  vendor's own dashboard rules exclude it
- Ask which fields are excluded in the vendor configuration

## What to say about the law, and what not to

In the EU the analysis runs through Art 5(3) and, for special-category fields, Art 9.

In the United States, session replay is litigated privately under the California Invasion of Privacy
Act, Cal. Penal Code § 631 — **and the law here is unsettled and moving.** *Javier v. Assurance IQ*
(9th Cir. 2022) held that consent obtained after recording began does not satisfy the statute.
*Torres v. Prudential Financial* (N.D. Cal., April 2025) then granted summary judgment for the
defendant, holding that replay tools do not read communications in transit.

So: **report the configuration fact, note that the US position is contested, and stop.** Do not tell
a user whether their setup survives a CIPA claim. That turns on consent timing and buffering facts
that are not in client-side source, and the case law moved twice in three years.

## Do not report

- Clarity's input masking. It cannot be disabled, so there is nothing to find
- The presence of a session-replay tool as a finding in itself
- Sampling rates. A lower rate records fewer people, not different data, and no provision here
  turns on it
- Any prediction about litigation outcome
