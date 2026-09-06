/**
 * Checks that every URL cited by the knowledge base still resolves.
 *
 * A stale citation is a correctness problem: the entry's whole defence is that
 * a reader can go and check the source. Run nightly, never in PR CI.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const urls = new Map(); // url -> where it was cited

const add = (url, where) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    if (!urls.has(url)) urls.set(url, where);
  }
};

for (const file of readdirSync('kb/vendors').filter((f) => f.endsWith('.json'))) {
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

const failures = [];
for (const [url, where] of urls) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'adequacy-link-check' },
      signal: AbortSignal.timeout(20_000),
    });
    // 403 is common for bot-blocking vendors and is not evidence the page moved.
    if (!response.ok && response.status !== 403) {
      failures.push({ url, where, status: String(response.status) });
    }
  } catch (error) {
    failures.push({ url, where, status: error.name === 'TimeoutError' ? 'timeout' : 'error' });
  }
}

console.log(`checked ${urls.size} url(s), ${failures.length} problem(s)`);
if (failures.length === 0) process.exit(0);

const report = [
  'The nightly link check found cited sources that no longer resolve.',
  '',
  '| Status | URL | Cited by |',
  '| --- | --- | --- |',
  ...failures.map((f) => `| ${f.status} | ${f.url} | \`${f.where}\` |`),
  '',
  'A moved page is not automatically a wrong fact, but the entry cannot be',
  'verified until the citation is updated.',
].join('\n');

writeFileSync('link-report.md', report);
console.error(report);
process.exit(1);
