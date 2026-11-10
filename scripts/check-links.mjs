/**
 * Checks that every URL cited by the knowledge base still resolves.
 *
 * A stale citation is a correctness problem: the entry's whole defence is that
 * a reader can go and check the source. Run nightly, never in PR CI.
 *
 * A failure is retried before it is reported. One 5xx or timeout is not
 * evidence that a page moved: on 2026-11-08 every github.com URL in the
 * knowledge base returned 504 for a single run and resolved the next night,
 * and each such night used to file an issue.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ATTEMPTS = 3;
const BACKOFF_MS = [10_000, 30_000];

const urls = new Map(); // url -> Set of files citing it

const add = (url, where) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    if (!urls.has(url)) urls.set(url, new Set());
    urls.get(url).add(where);
  }
};

for (const file of readdirSync('kb/vendors')
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const entry = JSON.parse(readFileSync(join('kb/vendors', file), 'utf8'));
  const where = `kb/vendors/${file}`;
  add(entry.homepage, where);
  add(entry.legal?.dpa?.url, where);
  add(entry.legal?.subprocessors?.url, where);
  add(entry.processing?.euRegion?.docUrl, where);
  for (const m of entry.legal?.transferMechanisms ?? []) add(m.url, where);
  for (const s of entry.sources ?? []) add(s.url, where);
}

const adequacy = JSON.parse(readFileSync('kb/adequacy-status.json', 'utf8'));
for (const s of adequacy.sources ?? []) add(s.url, 'kb/adequacy-status.json');
for (const d of adequacy.decisions ?? []) add(d.sourceUrl, 'kb/adequacy-status.json');

/** Returns null when the URL resolves, otherwise a short status string. */
const probe = async (url) => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'egressa-link-check' },
      signal: AbortSignal.timeout(20_000),
    });
    await response.body?.cancel();
    // 403 is common for bot-blocking vendors and is not evidence the page moved.
    if (response.ok || response.status === 403) return null;
    return String(response.status);
  } catch (error) {
    return error.name === 'TimeoutError' ? 'timeout' : 'error';
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// First pass over everything, then retry only what failed, as a batch, so one
// backoff covers every URL a short outage took down together.
let pending = [...urls.keys()];
const status = new Map();
for (let attempt = 0; attempt < ATTEMPTS && pending.length > 0; attempt++) {
  if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]);
  const still = [];
  for (const url of pending) {
    const result = await probe(url);
    if (result === null) status.delete(url);
    else {
      status.set(url, result);
      still.push(url);
    }
  }
  pending = still;
}

const failures = pending.map((url) => ({
  url,
  status: status.get(url),
  where: [...urls.get(url)].map((w) => `\`${w}\``).join(', '),
}));

console.log(
  `checked ${urls.size} url(s), ${failures.length} problem(s) after ${ATTEMPTS} attempt(s)`,
);
if (failures.length === 0) process.exit(0);

const report = [
  'The nightly link check found cited sources that no longer resolve.',
  `Each failed ${ATTEMPTS} times in one run, with backoff, before being listed.`,
  '',
  '| Status | URL | Cited by |',
  '| --- | --- | --- |',
  ...failures.map((f) => `| ${f.status} | ${f.url} | ${f.where} |`),
  '',
  'A moved page is not automatically a wrong fact, but the entry cannot be',
  'verified until the citation is updated. A 5xx can be an outage at the publisher:',
  'check whether their index page still links the same URL before',
  'changing a citation.',
].join('\n');

writeFileSync('link-report.md', report);
console.error(report);
process.exit(1);
