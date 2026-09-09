import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The PreToolUse hook runs on every Write and Edit in a session that has the
 * plugin installed, which makes precision and silence the whole product. A hook
 * that fires on a CSRF cookie, or twice for the same line, gets the plugin
 * turned off -- and then none of the rest of this repository runs either.
 */

interface HookOutput {
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
  additionalContext?: string;
  systemMessage?: string;
}

// A fresh data dir per test file keeps the once-per-session markers from
// leaking between cases and making a firing test pass by accident.
const DATA = mkdtempSync(join(tmpdir(), 'egressa-hook-test-'));

const run = (event: unknown): { out: HookOutput | null; code: number } => {
  try {
    const stdout = execFileSync('node', ['hooks/tracker-write-check.mjs'], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: DATA },
    });
    return { out: stdout.trim() ? (JSON.parse(stdout) as HookOutput) : null, code: 0 };
  } catch (error) {
    const e = error as { status: number };
    return { out: null, code: e.status };
  }
};

const write = (file: string, content: string, session = Math.random().toString(36)) => ({
  session_id: session,
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: file, content },
});

describe('the tracker write hook fires on', () => {
  it('a tracker initialised in new code', () => {
    const { out } = run(write('app/layout.tsx', 'mixpanel.init("TOKEN");'));
    expect(out?.systemMessage).toContain('tracker');
    expect(out?.additionalContext).toContain('Art 5(3)');
  });

  it('a session-replay init, with the masking question attached', () => {
    const { out } = run(write('app/rec.ts', 'LogRocket.init("org/app");'));
    expect(out?.systemMessage).toContain('session-replay');
    expect(out?.additionalContext).toContain('inputSanitizer');
  });

  it('a storage write that is not strictly necessary', () => {
    const { out } = run(write('app/u.ts', 'localStorage.setItem("utm_source", p);'));
    expect(out?.systemMessage).toContain('stored on the user');
  });

  it('a tracker introduced through MultiEdit', () => {
    const { out } = run({
      session_id: 'multi',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: 'app/p.ts',
        edits: [{ new_string: 'const x = 1;' }, { new_string: "fbq('init','11');" }],
      },
    });
    expect(out?.systemMessage).toContain('tracker');
  });
});

describe('the tracker write hook stays silent on', () => {
  const silent = (label: string, event: unknown) =>
    it(label, () => {
      const { out, code } = run(event);
      expect(out).toBeNull();
      expect(code).toBe(0);
    });

  silent('an edit that already carries its own consent gate', {
    session_id: 'gated',
    tool_name: 'Edit',
    tool_input: {
      file_path: 'app/a.ts',
      new_string: 'if (hasConsent("analytics")) { analytics.load({writeKey:"k"}); }',
    },
  });
  // Strictly necessary storage is exempt in the text of Art 5(3) itself.
  silent('a CSRF cookie', write('app/c.ts', 'document.cookie = `csrf_token=${t}; Secure`;'));
  silent('a session cookie', write('app/s.ts', 'document.cookie = `session=${id}; Secure`;'));
  silent('a test file', write('app/a.test.ts', 'mixpanel.init("T");'));
  silent('a fixture', write('fixtures/repos/x/a.ts', 'mixpanel.init("T");'));
  // The self-reference lesson: this repository documents the patterns it detects.
  silent(
    "the skill's own checklists",
    write('skill/privacy-review/specialists/consent-gating.md', 'mixpanel.init("T");'),
  );
  silent('a markdown file', write('docs/x.md', 'mixpanel.init("T");'));
  silent('ordinary code', write('app/x.ts', 'export const port = 3000;'));
  silent('malformed input', 'not json');
  silent('an unrelated tool', {
    session_id: 'z',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
});

describe('the tracker write hook', () => {
  it('reports a given pattern once per file per session', () => {
    const session = 'dedupe-session';
    expect(run(write('app/d.ts', 'posthog.init("k");', session)).out).not.toBeNull();
    expect(run(write('app/d.ts', 'posthog.init("k");', session)).out).toBeNull();
    // A different file in the same session is a different decision.
    expect(run(write('app/e.ts', 'posthog.init("k");', session)).out).not.toBeNull();
  });

  it('never blocks the tool call', () => {
    // The invariant that matters most. This tool detects; it does not
    // adjudicate, so it must never emit a permission decision and must never
    // exit 2, which is the only exit code that blocks.
    const { out, code } = run(write('app/block.ts', 'mixpanel.init("T");'));
    expect(code).toBe(0);
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out?.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
  });

  it('makes no forbidden claim in anything it emits', () => {
    const { out } = run(write('app/claim.ts', 'mixpanel.init("T");'));
    const text = `${out?.additionalContext} ${out?.systemMessage}`.toLowerCase();
    for (const word of ['compliant', 'violation', 'illegal', 'unlawful', 'guarantees']) {
      expect(text).not.toContain(word);
    }
  });
});
