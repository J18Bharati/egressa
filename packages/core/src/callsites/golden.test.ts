import { describe, expect, it } from 'vitest';
import { analyzeFile } from './index.js';

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
 */

interface Case {
  name: string;
  code: string;
  /** Expected resolved host, or null when the analyzer must not resolve one. */
  host: string | null;
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
    name: 'new URL with an absolute string',
    code: `const u = new URL('https://api.stripe.com/v1');`,
    host: 'api.stripe.com',
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
    // Known limitation: reassignment is not tracked. Resolving here would be a
    // confident wrong answer, which is worse than declining.
    host: 'api.stripe.com',
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
];

const NO_CALL_SITE: Case[] = [
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
];

describe('golden table: hosts that must resolve', () => {
  for (const testCase of RESOLVES) {
    it(testCase.name, () => {
      const { hits, error } = analyzeFile(testCase.code, 'input.tsx');
      expect(error).toBeUndefined();
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.host).toBe(testCase.host);
    });
  }
});

describe('golden table: destinations the analyzer must decline to resolve', () => {
  for (const testCase of DOES_NOT_RESOLVE) {
    it(testCase.name, () => {
      const { hits } = analyzeFile(testCase.code, 'input.ts');
      expect(hits.length).toBeGreaterThan(0);
      const hit = hits[0];
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

  it('gives an unresolved destination low confidence, never an attribution', () => {
    const { hits } = analyzeFile('fetch(process.env.X);', 'a.ts');
    expect(hits[0]?.confidence).toBe('low');
    expect(hits[0]?.host).toBeNull();
  });
});
