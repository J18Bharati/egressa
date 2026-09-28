import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The privacy-review output contract, as written. A model follows it, so no
 * test can run it; these pin the text that field test 4 found contradicting
 * itself, so the contradictions cannot come back one file at a time.
 */
const SKILL = 'skill/privacy-review';
const read = (path: string) => readFileSync(join(SKILL, path), 'utf8');

describe('privacy-review contract', () => {
  const schema = read('references/finding-schema.md');
  const skill = read('SKILL.md');
  const transfers = read('specialists/transfers.md');

  it('lists four decidability values, and context carries neither fix nor question', () => {
    for (const value of ['code', 'config', 'undecidable', 'context']) {
      expect(schema).toMatch(new RegExp(`^\\| \`${value}\` \\|`, 'm'));
    }
    expect(schema).toMatch(/^\| `context` \|.*neither `fix` nor `question`/m);
  });

  it('defines the transfers specialist’s _scanner line, and Step 4 checks it', () => {
    // F8. The only honest account of dropped scanner findings used to be
    // free commentary, which Step 4 discarded as invalid JSON.
    expect(schema).toContain('{"_scanner":');
    expect(skill).toContain('emitted + context + merged + dropped');
    expect(transfers).toContain('_scanner');
  });

  it('treats every exit status but 0 and 1 as a scan that did not run', () => {
    // Red team: a strict config exits 2 with no JSON, and the lane read as
    // clean because only exit 3 was named.
    for (const text of [transfers, readFileSync('skill/egressa/SKILL.md', 'utf8')]) {
      expect(text).toMatch(/exits 0 or 1/);
      expect(text).toMatch(/any other status/i);
    }
    expect(skill).toMatch(/`"engine":"none"`[\s\S]*not reviewed/);
  });

  it('never asks the transfers specialist for a summary it has no way to write', () => {
    expect(transfers).not.toMatch(/in your summary|say (?:so|that) plainly|in your output/i);
  });

  it('states one citation rule in every specialist', () => {
    // F9. SKILL.md said provisions and citations; each checklist said
    // provisions only.
    const rule = 'Take every `provision` and every `citation` from `references/legal-basis.md`.';
    const specialists = readdirSync(join(SKILL, 'specialists')).filter((f) => f.endsWith('.md'));
    expect(specialists.length).toBeGreaterThan(5);
    for (const file of specialists) expect(read(`specialists/${file}`)).toContain(rule);
    expect(skill).toMatch(/the only provisions and citations a specialist may\s+use/);
  });

  it('carries the Chapter V provision the transfers specialist cites', () => {
    expect(read('references/legal-basis.md')).toContain('GDPR Chapter V (Arts 44-49)');
    expect(transfers).toContain('GDPR Chapter V (Arts 44-49)');
  });

  it('reports context lines in a group of their own', () => {
    // F10. A context line was forced to carry a fix and rendered as settled.
    expect(skill).toContain('CONTEXT (<k>)');
    expect(transfers).toMatch(/`transfer\/adequate-country-egress` → .*`context`/s);
  });
});
