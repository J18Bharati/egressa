import { describe, expect, it } from 'vitest';
import type { Confidence } from '../types.js';
import { analyzeFile } from './index.js';
import { type SinkKind, clientConstructorSinks, vendorConstructorSinks } from './sinks.js';

/**
 * The golden table.
 *
 * Each case is a snippet and the host it must resolve to -- or `null`, meaning
 * the analyzer must decline to resolve it.
 *
 * The null half is the important half. Every documented limitation in
 * docs/LIMITATIONS.md has a case here, so "known false negative" is an
 * executable contract rather than a claim in prose. If someone later makes one
 * of these resolve, the test fails and they must move the limitation out of the
 * docs deliberately rather than by accident.
 *
 * A case that resolves to the WRONG host is far worse than one that resolves to
 * null: null produces a note asking a human to look, while a wrong host
 * produces a confident vendor attribution that is false.
 *
 * There is a third outcome, and it is not a shade of the first two. A hit can
 * resolve a host and still not be evidence that anything left: `new URL(...)`
 * and `new Request(...)` construct a parsed object and open no socket. Those
 * carry `kind: 'reference'`, and a case states the kind it expects so that a
 * change moving a sink between the two classes fails here rather than
 * silently renaming a reference into a transfer.
 */

interface Case {
  name: string;
  code: string;
  /** Expected resolved host, or null when the analyzer must not resolve one. */
  host: string | null;
  /**
   * Expected signal kind of the first hit. Omitted means `callsite`: a case
   * that does not say must be a genuine egress call, so a sink demoted to
   * `reference` by accident fails a row that never mentioned kinds.
   */
  kind?: SinkKind;
  /**
   * Expected confidence of the first hit, where the row exists to pin it.
   *
   * A CI gate runs `--min-confidence high`, so a resolved call site silently
   * demoted to `medium` stops failing that gate while every host in the table
   * still looks right. Rows that care say so.
   */
  confidence?: Confidence;
  /** Expected number of hits, where the row exists to pin that one transfer is reported once. */
  hitCount?: number;
  /** Substring expected in the unresolved reason, when host is null. */
  reason?: string;
  /** No call site at all should be reported. */
  noHit?: boolean;
}

const RESOLVES: Case[] = [
  {
    name: 'plain fetch with a literal URL',
    code: `fetch('https://api.stripe.com/v1/charges');`,
    host: 'api.stripe.com',
  },
  {
    name: 'template literal with a dynamic path',
    code: 'fetch(`https://api.stripe.com/v1/charges/${id}`);',
    host: 'api.stripe.com',
  },
  {
    name: 'template literal with a dynamic query string',
    code: 'fetch(`https://api.openai.com/v1/models?after=${cursor}`);',
    host: 'api.openai.com',
  },
  {
    name: 'template literal where the interpolation follows a hash',
    code: 'fetch(`https://api.stripe.com#${frag}`);',
    host: 'api.stripe.com',
  },
  {
    name: 'host-only literal with no path',
    code: `fetch('https://api.stripe.com');`,
    host: 'api.stripe.com',
  },
  {
    name: 'uppercase host is normalised',
    code: `fetch('https://API.Stripe.COM/v1');`,
    host: 'api.stripe.com',
  },
  {
    name: 'port is stripped',
    code: `fetch('https://api.stripe.com:443/v1');`,
    host: 'api.stripe.com',
  },
  {
    name: 'userinfo is stripped',
    code: `fetch('https://user:pass@api.stripe.com/v1');`,
    host: 'api.stripe.com',
  },
  {
    name: 'http as well as https',
    code: `fetch('http://api.stripe.com/v1');`,
    host: 'api.stripe.com',
  },
  {
    name: 'module-scope const holding the URL',
    code: `const BASE = 'https://api.openai.com/v1';\nfetch(BASE);`,
    host: 'api.openai.com',
  },
  {
    name: 'const chain two deep',
    code: `const A = 'https://api.stripe.com/v1';\nconst B = A;\nfetch(B);`,
    host: 'api.stripe.com',
  },
  {
    name: 'axios.get with a literal',
    code: `axios.get('https://api.stripe.com/v1/charges');`,
    host: 'api.stripe.com',
  },
  {
    name: 'axios.post with a template',
    code: 'axios.post(`https://api.mailgun.net/v3/${domain}/messages`, body);',
    host: 'api.mailgun.net',
  },
  {
    name: 'axios called directly with a config object',
    code: `axios({ url: 'https://api.stripe.com/v1', method: 'GET' });`,
    host: 'api.stripe.com',
  },
  {
    name: 'fetch with a Request-style config object',
    code: `fetch({ url: 'https://api.stripe.com/v1' });`,
    host: 'api.stripe.com',
  },
  {
    name: 'client binding through axios.create',
    code: `const api = axios.create({ baseURL: 'https://api.eu.mailgun.net' });\napi.get('/v3/messages');`,
    host: 'api.eu.mailgun.net',
  },
  {
    name: 'client binding whose baseURL comes from a const',
    code: `const BASE = 'https://eu.api.openai.com';\nconst client = axios.create({ baseURL: BASE });\nclient.post('/v1/chat');`,
    host: 'eu.api.openai.com',
  },
  {
    // Changed deliberately: the host is still right, but constructing a URL is
    // not a transfer. See docs/LIMITATIONS.md, "A constructed URL is a
    // reference, not a call".
    name: 'new URL with an absolute string names a vendor, it does not call one',
    code: `const u = new URL('https://api.stripe.com/v1');`,
    host: 'api.stripe.com',
    kind: 'reference',
  },
  {
    // Lifted from docs/LIMITATIONS.md: this was a deliberate false negative
    // while a template led by a constant could not be folded.
    name: 'new URL over a template led by a module-scope base constant',
    code: 'const API_BASE = `https://gmail.googleapis.com`;\nconst u = new URL(`${API_BASE}/messages`);',
    host: 'gmail.googleapis.com',
    kind: 'reference',
    confidence: 'medium',
  },
  {
    // The case that stops this row being deleted outright: the vendor
    // attribution is correct and worth keeping, only the claim is narrower.
    name: 'new URL over a module-scope base constant',
    code:
      `const API_BASE = 'https://gmail.googleapis.com';\n` +
      `const u = new URL(API_BASE + '/messages');`,
    host: 'gmail.googleapis.com',
    kind: 'reference',
  },
  {
    // `app.handle(new Request(...))` is an in-process dispatch in Elysia and
    // Hono -- no socket is opened. The analyzer cannot tell that from a
    // construct-then-fetch, so it reports the weaker of the two claims rather
    // than guessing either way.
    name: 'new Request handed to an in-process dispatcher',
    code: `app.handle(new Request('https://emit/openapi/json'));`,
    host: 'emit',
    kind: 'reference',
  },
  {
    name: 'new Request to localhost in a test dispatch',
    code: `app.handle(new Request('http://localhost/api/users'));`,
    host: 'localhost',
    kind: 'reference',
  },
  {
    // The outer call is the one that proves a transfer, and it reports once:
    // the inner construction is consumed rather than emitted beside it.
    name: 'fetch over a constructed Request is still a call site',
    code: `fetch(new Request('https://api.stripe.com/v1'));`,
    host: 'api.stripe.com',
    kind: 'callsite',
  },
  {
    name: 'fetch over a constructed URL is still a call site',
    code: `fetch(new URL('https://api.stripe.com/v1'));`,
    host: 'api.stripe.com',
    kind: 'callsite',
    confidence: 'high',
    hitCount: 1,
  },
  // The four rows below are the indirect forms of the two above. Only the
  // directly nested shape was covered when the `reference` kind landed, and
  // every one of these silently became `reference`/`medium` -- a resolved
  // third-country call site that a `--min-confidence high` gate stopped
  // seeing. They pin the kind, the confidence AND the count, because two of
  // them used to report the same transfer twice.
  {
    name: 'fetch over a constructed URL rendered with toString()',
    code: `fetch(new URL('https://api.stripe.com/v1/a').toString());`,
    host: 'api.stripe.com',
    kind: 'callsite',
    confidence: 'high',
    hitCount: 1,
  },
  {
    name: 'fetch over a constructed URL read through .href',
    code: `fetch(new URL('https://api.stripe.com/v1/c').href);`,
    host: 'api.stripe.com',
    kind: 'callsite',
    confidence: 'high',
    hitCount: 1,
  },
  {
    name: 'fetch over a URL bound to a module-scope const and rendered with toString()',
    code:
      `const u = new URL('https://api.stripe.com/v1/b');\n` + //
      `fetch(u.toString());`,
    host: 'api.stripe.com',
    kind: 'callsite',
    confidence: 'high',
    hitCount: 1,
  },
  {
    name: 'fetch over a Request bound to a module-scope const',
    code:
      `const req = new Request('https://api.stripe.com/v1/d');\n` + //
      `await fetch(req);`,
    host: 'api.stripe.com',
    kind: 'callsite',
    confidence: 'high',
    hitCount: 1,
  },
  {
    name: 'new WebSocket',
    code: `const ws = new WebSocket('wss://api.stripe.com/socket');`,
    host: 'api.stripe.com',
  },
  {
    name: 'new EventSource',
    code: `const es = new EventSource('https://api.openai.com/v1/stream');`,
    host: 'api.openai.com',
  },
  {
    name: 'navigator.sendBeacon',
    code: `navigator.sendBeacon('https://www.google-analytics.com/collect', data);`,
    host: 'www.google-analytics.com',
  },
  {
    name: 'https.request',
    code: `https.request('https://api.stripe.com/v1', cb);`,
    host: 'api.stripe.com',
  },
  {
    name: 'string concatenation where the left side carries the authority',
    code: `fetch('https://api.stripe.com/v1/' + id);`,
    host: 'api.stripe.com',
  },
  {
    name: 'TypeScript syntax with type annotations',
    code: `const res: Response = await fetch('https://api.stripe.com/v1' as string);`,
    host: 'api.stripe.com',
  },
  {
    name: 'JSX file containing a fetch',
    code: `const C = () => { fetch('https://api.stripe.com/v1'); return <div />; };`,
    host: 'api.stripe.com',
  },
  // Folding. A stable module-scope string is as static as a literal, so it is
  // folded into the text around it before the authority is read, and the
  // delimiter rule is applied once to the folded text. Field test: Gmail
  // clients written `${GMAIL_API_BASE}/watch` used to report unresolved.
  {
    name: 'template led by a module-scope base constant',
    code: "const B = 'https://www.googleapis.com/gmail/v1/users/me';\nfetch(`${B}/watch`);",
    host: 'www.googleapis.com',
    confidence: 'high',
  },
  {
    name: 'template led by a base with no path, closed by the next chunk',
    code: "const B = 'https://api.stripe.com';\nfetch(`${B}/v1/charges/${id}`);",
    host: 'api.stripe.com',
  },
  {
    name: 'constant folded into the authority itself',
    code: "const host = 'api.stripe.com';\nfetch(`https://${host}/v1`);",
    host: 'api.stripe.com',
  },
  {
    name: 'concatenation of a base constant and a static path',
    code: "const B = 'https://api.stripe.com';\nfetch(B + '/v1/' + id);",
    host: 'api.stripe.com',
  },
  {
    name: 'concatenation of a base constant and a template path',
    code: "const B = 'https://api.stripe.com';\nfetch(B + `/v1/${id}`);",
    host: 'api.stripe.com',
  },
  {
    // WHATWG URL parsing treats a backslash as a path delimiter in a special
    // scheme, so what follows it is path, not userinfo: the host is Stripe's.
    name: 'backslash ends the authority before an apparent userinfo, concatenated',
    code: "const U = 'https://api.stripe.com';\nfetch(U + '\\\\@evil.example/x');",
    host: 'api.stripe.com',
  },
  {
    name: 'backslash ends the authority before an apparent userinfo, literal',
    code: "fetch('https://api.stripe.com\\\\@evil.example/x');",
    host: 'api.stripe.com',
  },
  // The wrong-host regressions. Each of these used to resolve to the vendor
  // named by the left operand alone -- api.stripe.com at high confidence --
  // although the authority continues past it. The folded text is fully
  // static, so the true host is known and is what must be reported.
  {
    name: 'concatenation that continues the authority past a base constant',
    code: "const B = 'https://api.stripe.com';\nfetch(B + '.attacker.example/x');",
    host: 'api.stripe.com.attacker.example',
  },
  {
    name: 'literal concatenation that continues the authority',
    code: "fetch('https://api.stripe.com' + '.x.example/y');",
    host: 'api.stripe.com.x.example',
  },
  {
    name: 'template that continues the authority past a base constant',
    code: "const B = 'https://api.stripe.com';\nfetch(`${B}.eu/v1`);",
    host: 'api.stripe.com.eu',
  },
];

const DOES_NOT_RESOLVE: Case[] = [
  {
    name: 'host from an environment variable',
    code: `fetch(process.env.ANALYTICS_URL);`,
    host: null,
    reason: 'environment variable ANALYTICS_URL',
  },
  {
    name: 'host from a Vite-style import.meta env var',
    code: `fetch(import.meta.env.VITE_API_URL);`,
    host: null,
    reason: 'environment variable VITE_API_URL',
  },
  {
    name: 'const bound to an environment variable',
    code: `const BASE = process.env.API_BASE;\nfetch(BASE);`,
    host: null,
    reason: 'environment variable API_BASE',
  },
  {
    name: 'authority truncated by an interpolation',
    code: 'fetch(`https://${region}.api.stripe.com/v1`);',
    host: null,
    reason: 'interpolated',
  },
  {
    name: 'subdomain interpolated into the authority',
    code: 'fetch(`https://api.${tenant}.example.com/v1`);',
    host: null,
    reason: 'interpolated',
  },
  {
    name: 'whole URL interpolated',
    code: 'fetch(`${base}/v1/charges`);',
    host: null,
    reason: 'value of base is not known statically',
  },
  // Binding forms the unstable-name walk must count. Each binds the name a
  // second time, so the module-scope constant is not what the call reads; the
  // fold used to reach through every one of them to a confident wrong host.
  {
    name: 'destructured parameter shadowing a module constant',
    code: "const apiUrl = 'https://api.stripe.com';\nexport function client({ apiUrl }) { return fetch(`${apiUrl}/v1/charges`); }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'plain parameter shadowing a module constant',
    code: "const B = 'https://api.stripe.com';\nfunction f(B) { return fetch(`${B}/v1`); }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'arrow parameter shadowing a module constant',
    code: "const B = 'https://api.stripe.com';\nconst f = (B) => fetch(B + '/v1');",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'defaulted parameter shadowing a module constant',
    code: "const B = 'https://api.stripe.com';\nfunction f(B = 'https://evil.example') { return fetch(`${B}/v1`); }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'rest parameter shadowing a module constant',
    code: "const B = 'https://api.stripe.com';\nfunction f(...B) { return fetch(B); }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'catch parameter shadowing a module constant',
    code: "const B = 'https://api.stripe.com';\ntry { x(); } catch (B) { fetch(`${B}/v1`); }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'destructuring declaration shadowing a module constant',
    code: "const B = 'https://api.stripe.com';\nfunction f(o) { const { B } = o; return fetch(`${B}/v1`); }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'for-of target reassigning a module binding',
    code: "let B = 'https://api.stripe.com';\nfor (B of ['https://evil.example']) fetch(`${B}/v1`);",
    host: null,
    reason: 'reassigned',
  },
  {
    name: 'array pattern assignment reassigning a module binding',
    code: "let B = 'https://api.stripe.com';\n[B] = ['https://evil.example'];\nfetch(`${B}/v1`);",
    host: null,
    reason: 'reassigned',
  },
  {
    name: 'update expression on a module binding',
    code: "let B = 'https://api.stripe.com';\nB++;\nfetch(`${B}/v1`);",
    host: null,
    reason: 'reassigned',
  },
  {
    name: 'class method parameter shadowing a module constant',
    code: "const B = 'https://api.stripe.com';\nclass C { m(B) { return fetch(`${B}/v1`); } }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'function name shadowing a module constant',
    code: "const B = 'https://api.stripe.com';\nfunction g() { function B() {} return fetch(`${B}/v1`); }",
    host: null,
    reason: 'declared more than once',
  },
  {
    // Nothing proves `path` starts with a delimiter, so the authority is not
    // closed. This used to resolve to api.stripe.com at high confidence.
    name: 'base with no path followed by an unknown value',
    code: "const B = 'https://api.stripe.com';\nfetch(B + path);",
    host: null,
    reason: 'interpolated',
  },
  {
    name: 'template base with no path followed by an interpolation',
    code: "const B = 'https://api.stripe.com';\nfetch(`${B}${rest}`);",
    host: null,
    reason: 'interpolated',
  },
  {
    name: 'template base from an environment variable',
    code: 'const B = process.env.API_BASE;\nfetch(`${B}/v1`);',
    host: null,
    reason: 'environment variable API_BASE',
  },
  {
    name: 'template base declared twice',
    code:
      "const B = 'https://one.example.com/x';\nfetch(`${B}/y`);\n" +
      "function z() { const B = 'https://two.example.com/x'; return B; }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'template base reassigned',
    code: "let B = 'https://api.stripe.com';\nB = pick();\nfetch(`${B}/v1`);",
    host: null,
    reason: 'reassigned',
  },
  {
    name: 'template base used before it is declared',
    code: "fetch(`${B}/v1`);\nconst B = 'https://later.example.com';",
    host: null,
    reason: 'used before it is declared',
  },
  {
    name: 'concatenated base declared twice',
    code:
      "const B = 'https://one.example.com';\nfetch(B + '/y');\n" +
      "function z() { const B = 'https://two.example.com'; return B; }",
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'host from an object property read at runtime',
    code: `fetch(config.apiUrl);`,
    host: null,
    reason: 'computed at runtime',
  },
  {
    name: 'identifier declared in another module',
    code: `import { API_BASE } from './config';\nfetch(API_BASE);`,
    host: null,
    reason: 'not known statically',
  },
  {
    name: 'identifier reassigned with let',
    code: `let base = 'https://api.stripe.com';\nbase = pickHost();\nfetch(base);`,
    // The declared value is stale by the time the call runs, so the analyzer
    // declines rather than reporting the host it was initialised with.
    host: null,
    reason: 'reassigned',
  },
  {
    name: 'name shadowed in a nested scope',
    code:
      `const B = 'https://one.example.com/x';\nfetch(B);\n` +
      `function z() { const B = 'https://two.example.com/x'; return B; }`,
    // Binding collection is keyed on the name alone. Two declarations of one
    // name means the analyzer cannot say which the call site reads.
    host: null,
    reason: 'declared more than once',
  },
  {
    name: 'identifier used before it is declared',
    code: `fetch(C);\nconst C = 'https://later.example.com/x';`,
    host: null,
    reason: 'used before it is declared',
  },
  {
    name: 'identifier declared only inside an unrelated function',
    code: `function a() { const D = 'https://inner.example.com/x'; }\nfetch(D);`,
    host: null,
    reason: 'not known statically',
  },
  {
    name: 'client created with no base URL',
    code: `const api = axios.create();\napi.get('/v1/thing');`,
    host: null,
    reason: 'no base URL',
  },
  {
    name: 'client whose baseURL is an env var',
    code: `const api = axios.create({ baseURL: process.env.API });\napi.get('/x');`,
    host: null,
    reason: 'environment variable API',
  },
  {
    // Reading through `.toString()` must not invent what the constructor was
    // never given. The call is real, so it reports -- as a call site with no
    // host, exactly as `fetch(new URL(request.url))` does.
    name: 'fetch over a constructed URL whose own argument does not resolve',
    code: `fetch(new URL(request.url).toString());`,
    host: null,
    kind: 'callsite',
    reason: 'computed at runtime',
  },
];

const NO_CALL_SITE: Case[] = [
  {
    // The scheme belongs to the query, not the request: the destination is
    // the app's own origin. Applies to the literal as much as to the fold.
    name: 'relative proxy URL with an absolute URL in its query, literal',
    code: "fetch('/proxy?u=https://api.stripe.com/v1');",
    host: null,
    noHit: true,
  },
  {
    name: 'relative proxy URL with a constant in its query, concatenated',
    code: "const B = 'https://api.stripe.com/v1';\nfetch('/proxy?u=' + B);",
    host: null,
    noHit: true,
  },
  {
    name: 'relative proxy URL with a constant in its query, template',
    code: "const B = 'https://api.stripe.com/v1';\nfetch(`/proxy?u=${B}`);",
    host: null,
    noHit: true,
  },
  {
    name: 'relative fetch to own backend',
    code: `fetch('/api/charges');`,
    host: null,
    noHit: true,
  },
  {
    name: 'protocol-relative URL',
    code: `fetch('//api.stripe.com/v1');`,
    host: null,
    noHit: true,
  },
  {
    name: 'a non-sink function that happens to take a URL',
    code: `logger.info('https://api.stripe.com/v1');`,
    host: null,
    noHit: true,
  },
  {
    name: 'a string that is not a URL',
    code: `fetch('not-a-url');`,
    host: null,
    noHit: true,
  },
  {
    name: 'a numeric argument',
    code: `fetch(42);`,
    host: null,
    noHit: true,
  },
  {
    // The inverted-direction case: this parses an INBOUND request inside
    // HTTPS-redirect middleware. Five of these reached an external reviewer's
    // report as outbound transfers.
    name: 'new URL over an inbound request URL',
    code: `const u = new URL(request.url);`,
    host: null,
    noHit: true,
  },
  {
    // A database DSN rewritten only to set a query parameter. Nothing about
    // this is an unknown destination, so naming the variable would be noise
    // rather than a prompt to look.
    name: 'new URL over an unknown connection string',
    code: `const url = new URL(connectionString);\nurl.searchParams.set('sslmode', 'verify-full');`,
    host: null,
    noHit: true,
  },
  {
    // The binding table now records a constructed URL, so this guards the
    // near miss: an unresolved construction is recorded as nothing at all,
    // and reading it back through an accessor stays as silent as the
    // construction was.
    name: 'an inbound request URL read back through an accessor',
    code: `const u = new URL(request.url);\nconst target = u.href;`,
    host: null,
    noHit: true,
  },
];

describe('golden table: knowledge base client constructors', () => {
  // Sinks derived from `aliases.clientConstructors`. A vendor SDK's own
  // initialiser is the only place a configured region appears in source.
  const sinks = clientConstructorSinks([
    { module: 'posthog-js', export: 'default', hostOption: 'api_host' },
    { module: '@sentry/node', export: 'init', hostOption: 'dsn' },
    { module: '@supabase/supabase-js', export: 'createClient', hostOption: null },
  ]);

  const hosts = (code: string) => analyzeFile(code, 'input.ts', sinks).hits.map((h) => h.host);

  it('reads a region from a default-export initialiser', () => {
    expect(hosts("posthog.init(KEY, { api_host: 'https://eu.i.posthog.com' });")).toEqual([
      'eu.i.posthog.com',
    ]);
  });

  it("does not let one vendor's option name shadow another's", () => {
    // Both PostHog and Sentry initialise through `init`. Whichever sink sorts
    // first must not consume the call and resolve nothing.
    expect(hosts("Sentry.init({ dsn: 'https://abc@o1.ingest.sentry.io/2' });")).toEqual([
      'o1.ingest.sentry.io',
    ]);
  });

  it('reads a positional project URL', () => {
    expect(hosts("createClient('https://abcdefghij.supabase.co', KEY);")).toEqual([
      'abcdefghij.supabase.co',
    ]);
  });

  it('never reports a credential argument as a destination', () => {
    // The key sits at argument 0 and resolves to nothing. Reporting it as
    // "host supplied by environment variable POSTHOG_KEY" would name a secret
    // as though it were a recipient.
    const { hits } = analyzeFile(
      'posthog.init(process.env.POSTHOG_KEY, { autocapture: true });',
      'input.ts',
      sinks,
    );
    expect(hits).toEqual([]);
  });

  it('still refuses a bare URL passed to an arbitrary function', () => {
    // The catch-all sink reads config objects only, so this stays a non-sink
    // even with knowledge base constructors loaded.
    expect(
      analyzeFile("logger.info('https://api.stripe.com/v1');", 'input.ts', sinks).hits,
    ).toEqual([]);
  });
});

describe('golden table: region identifiers', () => {
  const sinks = vendorConstructorSinks([
    {
      vendorId: 'aws',
      constructors: [
        {
          module: '@aws-sdk/client-s3',
          export: 'S3Client',
          hostOption: null,
          regionOption: 'region',
        },
      ],
    },
  ]);
  const regions = (code: string) =>
    analyzeFile(code, 'input.ts', sinks).hits.map((h) => h.region ?? null);

  it('reads a region literal from a constructed client', () => {
    expect(regions("new S3Client({ region: 'eu-west-1' });")).toEqual(['eu-west-1']);
  });

  it('reads one through a module-scope constant', () => {
    expect(regions("const R = 'eu-central-1';\nnew S3Client({ region: R });")).toEqual([
      'eu-central-1',
    ]);
  });

  // The null half. A region assembled at deploy time is not a fact about this
  // repository, and a guess about where data lands is worse than no answer.
  it('refuses a region from an environment variable', () => {
    expect(
      analyzeFile('new S3Client({ region: process.env.AWS_REGION });', 'a.ts', sinks).hits,
    ).toEqual([]);
  });

  it('refuses an interpolated region', () => {
    expect(analyzeFile('new S3Client({ region: `eu-${zone}` });', 'a.ts', sinks).hits).toEqual([]);
  });

  it('refuses a region whose binding is declared twice', () => {
    const code =
      "const R = 'eu-west-1';\nnew S3Client({ region: R });\nfunction z() { const R = 'us-east-1'; }";
    expect(analyzeFile(code, 'a.ts', sinks).hits).toEqual([]);
  });

  it('does not turn an arbitrary call with a region into a call site', () => {
    // No knowledge base sink names `logger`, so this is not an egress point
    // however its options are spelled.
    expect(analyzeFile("logger.info({ region: 'us-east-1' });", 'a.ts', sinks).hits).toEqual([]);
  });
});

describe('golden table: hosts that must resolve', () => {
  for (const testCase of RESOLVES) {
    it(testCase.name, () => {
      const { hits, error } = analyzeFile(testCase.code, 'input.tsx');
      expect(error).toBeUndefined();
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.host).toBe(testCase.host);
      expect(hits[0]?.kind).toBe(testCase.kind ?? 'callsite');
      if (testCase.confidence) expect(hits[0]?.confidence).toBe(testCase.confidence);
      if (testCase.hitCount !== undefined) expect(hits).toHaveLength(testCase.hitCount);
    });
  }
});

describe('golden table: destinations the analyzer must decline to resolve', () => {
  for (const testCase of DOES_NOT_RESOLVE) {
    it(testCase.name, () => {
      const { hits } = analyzeFile(testCase.code, 'input.ts');
      expect(hits.length).toBeGreaterThan(0);
      const hit = hits[0];
      expect(hit?.kind).toBe(testCase.kind ?? 'callsite');
      if (testCase.host === null) {
        expect(hit?.host).toBeNull();
        if (testCase.reason) expect(hit?.unresolvedReason).toContain(testCase.reason);
      } else {
        // Documented limitation: recorded here so a future change is deliberate.
        expect(hit?.host).toBe(testCase.host);
      }
    });
  }
});

describe('golden table: code that is not an outbound call at all', () => {
  for (const testCase of NO_CALL_SITE) {
    it(testCase.name, () => {
      const { hits } = analyzeFile(testCase.code, 'input.ts');
      expect(hits).toEqual([]);
    });
  }
});

describe('analyzeFile: locations and robustness', () => {
  it('reports the line of the call, so annotations land in the right place', () => {
    const code = `const a = 1;\nconst b = 2;\nfetch('https://api.stripe.com/v1');\n`;
    const { hits } = analyzeFile(code, 'input.ts');
    expect(hits[0]?.location.startLine).toBe(3);
    expect(hits[0]?.snippet).toBe("fetch('https://api.stripe.com/v1');");
  });

  it('reports a syntax error rather than throwing', () => {
    const { error } = analyzeFile('const = = =;', 'broken.ts');
    expect(typeof error === 'string' || error === undefined).toBe(true);
  });

  it('gives a binding-resolved host lower confidence than a literal one', () => {
    const direct = analyzeFile(`fetch('https://api.stripe.com/v1');`, 'a.ts');
    expect(direct.hits[0]?.confidence).toBe('high');

    // axios.create is itself a call site declaring a destination, so it is
    // reported at high confidence; the later api.get() resolves only through
    // the binding and is reported at medium.
    const viaClient = analyzeFile(
      `const api = axios.create({ baseURL: 'https://api.stripe.com' });\napi.get('/v1');`,
      'b.ts',
    );
    expect(viaClient.hits).toHaveLength(2);
    expect(viaClient.hits[0]?.confidence).toBe('high');
    expect(viaClient.hits[1]?.confidence).toBe('medium');
    expect(viaClient.hits[1]?.host).toBe('api.stripe.com');
  });

  it('never lets a reference reach the confidence of a call site', () => {
    // Both read the host off a string literal, so the certainty about the
    // *string* is identical. What differs is what it proves.
    const call = analyzeFile(`fetch('https://api.stripe.com/v1');`, 'a.ts');
    expect(call.hits[0]?.confidence).toBe('high');

    const reference = analyzeFile(`const u = new URL('https://api.stripe.com/v1');`, 'b.ts');
    expect(reference.hits[0]?.kind).toBe('reference');
    expect(reference.hits[0]?.confidence).toBe('medium');
  });

  it('reports one hit, not two, when a call site wraps a constructed Request', () => {
    const { hits } = analyzeFile(`fetch(new Request('https://api.stripe.com/v1'));`, 'a.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('callsite');
  });

  it('reports one hit when the constructed Request reaches the call through a binding', () => {
    // The construction is emitted several statements before the call that
    // consumes it, so the deduplication cannot be a skip on the way past.
    const { hits } = analyzeFile(
      `const req = new Request('https://api.stripe.com/v1/d');\nawait fetch(req);`,
      'a.ts',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('callsite');
    expect(hits[0]?.confidence).toBe('high');
  });

  it('still reports the reference when nothing consumes the constructed URL', () => {
    // The suppression must be driven by an actual consumer, not by the shape
    // of the construction.
    const { hits } = analyzeFile(
      `const u = new URL('https://api.stripe.com/v1/b');\nconsole.log(u);`,
      'a.ts',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('reference');
    expect(hits[0]?.confidence).toBe('medium');
  });

  it('reports each call separately when two share one constructed URL', () => {
    const { hits } = analyzeFile(
      `const u = new URL('https://api.stripe.com/v1/b');\nfetch(u.toString());\nfetch(u.href);`,
      'a.ts',
    );
    expect(hits.map((h) => h.kind)).toEqual(['callsite', 'callsite']);
  });

  it('gives an unresolved destination low confidence, never an attribution', () => {
    const { hits } = analyzeFile('fetch(process.env.X);', 'a.ts');
    expect(hits[0]?.confidence).toBe('low');
    expect(hits[0]?.host).toBeNull();
  });
});

describe('golden table: a discarded resolution consumes nothing', () => {
  // A reference read while resolving the head of a fold is consumed only if
  // that resolution is the one returned. When the head is followed by more
  // text the result is discarded as unresolved, and the construction must
  // still be reported as the reference it is.
  it.each([
    "const u = new URL('https://api.stripe.com/v1');\nfetch(`${u}`);",
    "const u = new URL('https://api.stripe.com/v1');\nfetch(u + 'v1');",
  ])('keeps the reference in %s', (code) => {
    const { hits } = analyzeFile(code, 'input.ts');
    expect(hits.some((h) => h.kind === 'reference' && h.host === 'api.stripe.com')).toBe(true);
  });
});
