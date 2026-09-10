#!/usr/bin/env node
/**
 * PreToolUse hook: notice a tracker, client-side storage write or session-replay
 * init at the moment it is written, rather than at review time.
 *
 * Three rules govern it, and all three exist to keep it from becoming noise:
 *
 * 1. It NEVER blocks. No `permissionDecision` is ever emitted, so the normal
 *    permission flow is untouched. Blocking an edit on a privacy heuristic
 *    would be indefensible -- the tool detects, it does not adjudicate, which
 *    is the same reason nothing in the scanner defaults to `error`.
 * 2. It fires once per session, per file, per pattern. A hook that repeats
 *    itself on every keystroke gets the whole plugin disabled.
 * 3. It stays silent unless it is confident. Strictly-necessary storage is
 *    exempt under Art 5(3) itself, and an edit that already contains a consent
 *    check is not worth a comment.
 *
 * Any unexpected condition exits 0 in silence. A hook that breaks someone's
 * editing session is worse than a hook that misses something.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CODE_FILE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro|html|htm)$/i;

/** Paths where these patterns are documentation or test data, not behaviour. */
const NOT_UNDER_REVIEW =
  /(^|\/)(node_modules|dist|build|\.next|coverage|fixtures)\/|\.(test|spec)\.[jt]sx?$|(^|\/)skill\/privacy-review\//;

/** An edit that already gates itself needs no comment. */
const CONSENT_IN_EDIT =
  /hasConsent|consentGranted|consent[_-]?[Mm]ode|__tcfapi|analytics_storage|onetrust|OneTrust|Cookiebot|klaro|osano|cookieconsent/;

/** Storage that is exempt under the Art 5(3) strict-necessity carve-out. */
const STRICTLY_NECESSARY = /csrf|xsrf|session|auth|token|consent|locale|lang|theme|currency|cart/i;

const PATTERNS = [
  {
    id: 'tracker-init',
    test: /\b(posthog\.init|mixpanel\.init|amplitude\.(init|getInstance)|analytics\.load|heap\.load)\s*\(|\bgtag\s*\(\s*['"]config['"]|\bfbq\s*\(\s*['"]init['"]|\bttq\.load\s*\(|\bsnaptr\s*\(\s*['"]init['"]|_linkedin_partner_id/,
    provision: 'ePrivacy Directive 2002/58/EC Art 5(3)',
    what: 'an analytics or advertising tracker is being initialised',
    ask: 'Is this call reachable when the module is evaluated, before the user has chosen? If so it runs before any consent can exist.',
  },
  {
    id: 'session-replay-init',
    test: /\bLogRocket\.init\s*\(|\bSmartlook\.init\s*\(|\bFS\.identify\s*\(|\bclarity\s*\(\s*['"]|\bhj\s*\(\s*['"]/,
    provision: 'ePrivacy Directive 2002/58/EC Art 5(3)',
    what: 'a session-replay tool is being initialised',
    ask: 'Are text inputs masked? LogRocket is the one major vendor whose default records them: `dom.inputSanitizer` defaults to false. The others mask by default, so the question there is whether masking was switched off.',
  },
  {
    id: 'client-storage',
    test: /document\.cookie\s*=|(?:local|session)Storage\.setItem\s*\(|(?:cookies\(\)|cookieStore)\.set\s*\(|\bres(?:ponse)?\.cookies?\.set\s*\(|\bres\.cookie\s*\(|\bsetCookie\s*\(|\breply\.setCookie\s*\(/,
    provision: 'ePrivacy Directive 2002/58/EC Art 5(3)',
    what: 'something is being stored on the user’s device',
    ask: 'Is this strictly necessary for a service the user asked for? If it is, no consent is needed and there is nothing to do. If it is analytics or attribution, it needs a gate.',
  },
];

const read = () =>
  new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      raw += c;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
  });

/** Only the text being introduced. An unchanged file is not a new decision. */
function addedText(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  if (toolName === 'Write') return String(input.content ?? '');
  if (toolName === 'Edit') return String(input.new_string ?? '');
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((e) => String(e?.new_string ?? '')).join('\n');
  }
  return '';
}

/**
 * Whether every storage key in this edit is exempt under Art 5(3).
 *
 * The exemption must be tested against the *key being written*, not the whole
 * edit. Testing the edit meant one incidental word anywhere in the added text
 * silenced the report: a file that imports `@clerk/nextjs` matches `auth`, so a
 * `localStorage.setItem('utm_source', ...)` in the same write was suppressed --
 * which is the case this pattern exists to catch.
 *
 * A write whose key is not a string literal cannot be checked against the list,
 * so it is not treated as exempt. Reporting a question about an unknown key is
 * the lesser failure.
 */
function everyStorageKeyIsExempt(text) {
  const writes = text.match(
    /document\.cookie\s*=|(?:local|session)Storage\.setItem\s*\(|(?:cookies\(\)|cookieStore)\.set\s*\(|\bres(?:ponse)?\.cookies?\.set\s*\(|\bres\.cookie\s*\(|\bsetCookie\s*\(|\breply\.setCookie\s*\(/g,
  );
  const keys = [
    ...text.matchAll(/(?:local|session)Storage\.setItem\s*\(\s*['"`]([^'"`]+)['"`]/g),
    ...text.matchAll(/document\.cookie\s*=\s*['"`]\s*([A-Za-z0-9_.-]+)\s*=/g),
    ...text.matchAll(
      /(?:(?:cookies\(\)|cookieStore)\.set|res(?:ponse)?\.cookies?\.set|res\.cookie|setCookie|reply\.setCookie)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    ),
  ].map((m) => m[1]);

  // A key the patterns could not read is a key that cannot be cleared.
  if (!writes || keys.length !== writes.length) return false;
  return keys.every((key) => STRICTLY_NECESSARY.test(key));
}

function alreadyReported(sessionId, filePath, patternId) {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'egressa-hook');
  const dir = join(base, 'seen');
  const key = createHash('sha1').update(`${sessionId}:${filePath}:${patternId}`).digest('hex');
  const marker = join(dir, key);
  try {
    if (existsSync(marker)) return true;
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, '');
  } catch {
    // Cannot persist state, so fall through and report. Repeating is a lesser
    // failure than staying silent about the first occurrence.
  }
  return false;
}

const main = async () => {
  const raw = await read();
  if (!raw.trim()) return;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const file = String(event?.tool_input?.file_path ?? '');
  if (!file || !CODE_FILE.test(file) || NOT_UNDER_REVIEW.test(file)) return;

  const added = addedText(String(event?.tool_name ?? ''), event?.tool_input);
  if (!added || CONSENT_IN_EDIT.test(added)) return;

  const hit = PATTERNS.find((p) => p.test.test(added));
  if (!hit) return;
  if (hit.id === 'client-storage' && everyStorageKeyIsExempt(added)) return;
  if (alreadyReported(String(event?.session_id ?? ''), file, hit.id)) return;

  const context = [
    `Egressa noticed while writing ${file}: ${hit.what}.`,
    `Provision engaged: ${hit.provision}.`,
    hit.ask,
    'This is an observation about a pattern, not a conclusion about lawfulness, which depends on facts that are not in the source. Run /privacy-review for the full pass, which reads surrounding control flow and applies the exemptions.',
  ].join(' ');

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse' },
      additionalContext: context,
      systemMessage: `egressa: ${hit.what} in ${file} — ${hit.provision}. Run /privacy-review for the full pass.`,
    })}\n`,
  );
};

main().catch(() => {
  // Never surface a hook crash into someone's editing session.
});
