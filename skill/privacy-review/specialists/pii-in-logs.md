# Personal data in logs specialist

Dispatch when `SCOPE_LOGGING` is true.
Emit findings per `references/finding-schema.md`. Cite only provisions in `references/legal-basis.md`.

Logs leave the system a person designed and land in places nobody planned: a log aggregator in
another country, a retention window measured in years, an error tracker every engineer can read.
This is the second strongest check in the review, because the detection is well understood and the
enforcement record is unambiguous.

The provision is not a logging article. It is `GDPR Art 5(1)(f)` and `GDPR Art 32` — security of
processing. Credentials in plaintext are a security-measures failure, which is how the Irish DPC
treated Meta's plaintext passwords in its €91,000,000 decision of 27 September 2024.

## Sinks

`console.log|info|warn|error|debug|trace`, `process.stdout.write`, and any logger method on a
recognised logger: `pino`, `winston`, `bunyan`, `log4js`, `loglevel`, `debug`, plus a project's own
wrapper.

**When the logger's import is not traceable** — a bare `logger.info(...)` with no import in the file,
a global, an injected dependency, a re-export you cannot follow — treat it as a sink anyway on the
strength of the name and the call shape. A method named `info`, `warn`, `error`, `debug` or `log` on
an object named `logger`, `log`, `logging` or `console` is a logging call, and refusing to report it
because the import is invisible would miss the most common shape in real server code.

Cap confidence at 7 when you could not see the import, and say in `evidence` that the logger was
identified by name rather than by its definition. If the name is genuinely ambiguous — a method
named `log` on something that might be a domain object, an audit trail, or an event emitter — that
is a `config` finding with a question, not a silent skip and not a `code` finding.

Also treat as sinks, because they leave the machine: `Sentry.captureException`,
`Sentry.captureMessage`, `Sentry.setContext`, `Sentry.setUser`, `datadogLogs`, `analytics.track`
where the payload is an error, and OpenTelemetry span attributes.

An error tracker is a stronger finding than a local log line, not a weaker one: the data crosses a
network boundary to a third party, so the transfers question stacks on top.

## Tier 1 — credentials and secrets. Report every time

```js
console.log(password);
logger.info('token: ' + accessToken);
console.error({ apiKey, err });
Sentry.setContext('auth', { sessionToken });
```

Any argument, or property of an argument object, whose identifier matches: `password`, `passwd`,
`pwd`, `secret`, `token`, `accessToken`, `refreshToken`, `apiKey`, `api_key`, `privateKey`,
`clientSecret`, `sessionId`, `cookie`, `authorization`, `credentials`.

- Severity `high`, confidence 8-10, `decidability: "code"`
- Provision: `GDPR Art 5(1)(f)` and `GDPR Art 32`
- Fix: remove the field, or redact at the logger's serialiser level so it cannot come back — name
  the redaction mechanism the project's logger already has if it has one (`pino`'s `redact`,
  `winston` formats)

## Tier 2 — a whole request, response, user or error object

```js
console.log(req.body);
logger.info({ ...req.body, action: 'signup' });
app.use((req, res, next) => { logger.debug(req); next(); });
console.error(err);            // when err is an HTTP error carrying headers
logger.info(user);
```

The signal is the **shape of the argument**: a whole request body, a whole request, a whole user
record, a whole error that carries headers or a request. Whatever is in that object today, someone
will add a field to it tomorrow and no one will revisit the log line.

- Severity `medium`, or `high` where the route handles authentication, payment or health data
- Confidence 7-9 for a direct `req.body`; 5-6 for a spread or a variable you had to follow
- `decidability: "code"` when the object flows straight in, `config` when it passes through a helper
- Fix: log an explicit allowlist of fields, showing the two or three the log line actually needs

## Tier 3 — a named personal-data field

```js
console.log('signup for', user.email);
logger.info(`user ${user.phone} verified`);
```

Property access matching `email`, `phone`, `ssn`, `nationalId`, `dob`, `dateOfBirth`, `address`,
`postcode`, `zip`, `ip`, `ipAddress`, `fullName`, `firstName`, `lastName`, `cardNumber`, `iban`.

- Severity `medium`; `low` where the log is behind a debug level that is off in production **and you
  can see that** in config
- Confidence 6-8

## Tier 4 — special category, Art 9

Anything matching `health`, `diagnosis`, `medication`, `religion`, `ethnicity`, `race`,
`sexualOrientation`, `biometric`, `genetic`, `politicalOpinion`, `tradeUnion`, `criminalRecord`.

Severity `high` regardless of the sink. Art 9 data in a log is the worst version of this finding.

## Where this becomes undecidable — say so rather than guessing

```js
const safeUser = { id: user.id, plan: user.plan };
console.log(safeUser);            // fine, and structurally identical to a bad case
```

```js
function redact(obj) { const { password, ...rest } = obj; return rest; }
console.log(redact(req.body));    // sanitised, but only provably so across a function boundary
```

Inline construction you can follow. Redaction inside a called function you cannot — the moment
sanitisation happens in a helper, deciding it requires call resolution this review does not have.

When you cannot follow it: emit `decidability: "config"` with a question naming the helper, or emit
nothing. **Do not report a redacted log as a leak.** That is the single fastest way to get this
whole review switched off, and the research on scanner abandonment is blunt about it: once
developers learn most alerts are noise, they treat every alert as noise, correct ones included.

## Do not report

- Log lines that print an identifier only — a user id, a request id, a trace id. A pseudonymous
  identifier in a log is normal and often required for operations
- `console.log` in a test file, a fixture, a seed script, or an example
- Log volume, log levels, or the absence of structured logging. Not privacy findings
- The absence of a log-retention policy. Not visible in code — that belongs in the `NOT CHECKED`
  block, not in a finding
