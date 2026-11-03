import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DISCLAIMER,
  DISCLAIMER_SHORT,
  NON_ASSESSMENT,
  applyOverlay,
  checkFacts,
  findForbiddenClaims,
  loadFacts,
  scan,
  summarise,
  toSarif,
} from '@egressa/core';
import { loadKnowledgeBase } from '@egressa/kb';
import { describe, expect, it } from 'vitest';
import { formatCheck } from '../packages/cli/src/commands/facts.js';
import { formatHuman } from '../packages/cli/src/format/human.js';
import { formatMarkdown } from '../packages/cli/src/format/markdown.js';

/**
 * The claim scope is enforced here rather than trusted to reviewers.
 *
 * Language drift is the failure mode for tooling in this category: a summary
 * written months apart from the policy quietly starts implying that a clean
 * scan means compliance. These tests make that impossible to merge.
 */

const read = (path: string) => readFileSync(path, 'utf8');
/**
 * Markdown wraps prose across lines and prefixes blockquotes, so compare on
 * text with quote markers removed and whitespace collapsed.
 */
const flat = (text: string) =>
  text
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

const result = scan({
  root: 'fixtures/repos/nextjs-analytics-heavy',
  toolVersion: '0.1.0',
  kbPath: 'kb',
  includeCallsites: true,
  now: new Date('2026-09-06T12:00:00.000Z'),
});

describe('the disclaimer reaches every surface', () => {
  it('JSON output', () => {
    expect(result.disclaimer).toBe(DISCLAIMER);
  });

  it('SARIF tool driver', () => {
    const sarif = toSarif(result, { toolVersion: '0.1.0' }) as {
      runs: { tool: { driver: { fullDescription: { text: string } } } }[];
    };
    expect(sarif.runs[0]?.tool.driver.fullDescription.text).toBe(DISCLAIMER);
  });

  it('every SARIF rule help pane', () => {
    const sarif = toSarif(result, { toolVersion: '0.1.0' }) as {
      runs: { tool: { driver: { rules: { id: string; help: { markdown: string } }[] } } }[];
    };
    for (const rule of sarif.runs[0]?.tool.driver.rules ?? []) {
      expect({ rule: rule.id, ok: rule.help.markdown.includes(DISCLAIMER) }).toEqual({
        rule: rule.id,
        ok: true,
      });
    }
  });

  it('markdown output', () => {
    expect(formatMarkdown(result)).toContain(DISCLAIMER);
  });

  it('human output carries at least the short form', () => {
    expect(formatHuman(result, { color: false })).toContain('not a compliance assessment');
  });

  it('the README', () => {
    expect(flat(read('README.md'))).toContain(flat(DISCLAIMER));
  });

  it('the skill', () => {
    expect(flat(read('plugin/skills/egressa/SKILL.md'))).toContain(flat(DISCLAIMER));
  });

  it('the MCP server, which scopes every tool description', () => {
    const source = read('packages/mcp/src/server.ts');
    expect(source).toContain('const scoped =');
    expect(source).toContain('${DISCLAIMER}');
  });
});

// A scan a repository's facts file changed, trusted so every fact applies:
// the provenance lines it adds are generated text like any other.
const OVERLAY = 'fixtures/repos/overlay-dpf';
const OVERLAY_NOW = new Date('2026-11-10T12:00:00.000Z');
const overlayFacts = loadFacts(OVERLAY);
const overlay = scan({
  root: OVERLAY,
  toolVersion: '0.1.0',
  kbPath: 'kb',
  includeCallsites: true,
  now: OVERLAY_NOW,
  facts: overlayFacts,
  trustFacts: true,
});
const kb = loadKnowledgeBase({ kbPath: 'kb' });
const factsCheck = overlayFacts
  ? formatCheck(applyOverlay(kb, checkFacts(overlayFacts, kb, OVERLAY_NOW), { trustFacts: false }))
  : '';

describe('a scan shaped by repository facts keeps the claim scope', () => {
  it('the fixture has facts to apply', () => {
    expect(overlay.facts?.findingsDependingOnFacts).toBeGreaterThan(0);
    expect(factsCheck).toContain('loosening-not-trusted');
  });
  it('markdown and human output still carry the disclaimer', () => {
    expect(flat(formatMarkdown(overlay))).toContain(flat(DISCLAIMER));
    expect(formatHuman(overlay, { color: false })).toContain(DISCLAIMER_SHORT);
  });
});

describe('no generated output can claim compliance', () => {
  const surfaces: [string, string][] = [
    ['json', JSON.stringify(result)],
    ['sarif', JSON.stringify(toSarif(result, { toolVersion: '0.1.0' }))],
    ['markdown', formatMarkdown(result)],
    ['human', formatHuman(result, { color: false })],
    ['json with facts', JSON.stringify(overlay)],
    ['sarif with facts', JSON.stringify(toSarif(overlay, { toolVersion: '0.1.0' }))],
    ['markdown with facts', formatMarkdown(overlay)],
    ['human with facts', formatHuman(overlay, { color: false })],
    ['MCP summary with facts', JSON.stringify(summarise(overlay))],
    ['facts check', factsCheck],
  ];

  for (const [name, text] of surfaces) {
    it(`${name} output is free of forbidden claim words`, () => {
      expect({ surface: name, forbidden: findForbiddenClaims(text) }).toEqual({
        surface: name,
        forbidden: [],
      });
    });
  }

  it('the skill instructions do not themselves make a forbidden claim', () => {
    // SKILL.md gives instructions; the forbidden-word table lives in
    // references/language-rules.md, which quotes them deliberately.
    expect(findForbiddenClaims(read('plugin/skills/egressa/SKILL.md'))).toEqual([]);
  });

  it('knowledge base entries contain no evaluative language', () => {
    // Computed for the same reason the skill list below is: a hardcoded set of
    // ids lets the next vendor entry ship outside the contract just by nobody
    // remembering to add it.
    const ids = vendorIds();
    expect(ids.length).toBeGreaterThan(4);
    for (const id of ids) {
      const entry = read(`kb/vendors/${id}.json`);
      expect({ id, forbidden: findForbiddenClaims(entry) }).toEqual({ id, forbidden: [] });
    }
  });
});

describe('shipped shell scripts are inside the claim scope', () => {
  // The markdown walk above covers `.md` only, so a script under plugin/skills/ used to
  // ship with no claim-scope enforcement at all. The hook block below is the
  // precedent for extending the contract to a non-markdown surface.
  const scripts = skillFiles('.sh');

  it('finds shell scripts to check at all', () => {
    expect(scripts.length).toBeGreaterThan(1);
  });

  for (const file of scripts) {
    it(`${file} makes no forbidden claim`, () => {
      expect(findForbiddenClaims(read(file))).toEqual([]);
    });
  }

  it('the live AWS script refuses to run unless it is opted into', () => {
    // It is the only thing here that reaches the network, so the default has
    // to be off and the refusal has to be loud.
    const script = read('plugin/skills/egressa/scripts/reconcile-aws.sh');
    expect(script).toContain('EGRESSA_ALLOW_AWS');
    expect(script).toContain('DID NOT RUN');
    // Read-only: nothing that changes state in someone's account.
    expect(script).not.toMatch(/aws [a-z0-9-]+ (create|delete|put|update|modify|terminate)/);
  });
});

/** Every vendor entry in the knowledge base, by id, found by reading kb/. */
const vendorIds = (): string[] =>
  readdirSync('kb/vendors')
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();

/**
 * Every markdown file shipped under `plugin/skills/`, found by walking the tree rather
 * than by a hand-maintained list.
 *
 * The list is computed on purpose. A hardcoded one lets the next specialist
 * checklist ship outside the contract simply by nobody remembering to add it,
 * which is the same drift this file exists to prevent -- one directory down.
 */
const skillFiles = (extension: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(extension)) out.push(path);
    }
  };
  walk('plugin/skills');
  return out.sort();
};

const skillMarkdown = (): string[] => skillFiles('.md');

describe('every shipped skill is inside the claim scope', () => {
  const files = skillMarkdown();

  it('finds skill markdown to check at all', () => {
    // Guards against a refactor that moves the directory and silently
    // turns every assertion below into a vacuous pass over an empty list.
    expect(files.length).toBeGreaterThan(4);
  });

  for (const file of files.filter((f) => f.endsWith('/SKILL.md'))) {
    it(`${file} refuses the assessment claim`, () => {
      expect(flat(read(file))).toContain(flat(NON_ASSESSMENT));
    });
  }

  for (const file of files) {
    // language-rules.md quotes the forbidden vocabulary deliberately -- it is
    // the table that tells the model what never to write.
    if (file.endsWith('language-rules.md')) continue;
    it(`${file} makes no forbidden claim`, () => {
      expect({ file, forbidden: findForbiddenClaims(read(file)) }).toEqual({
        file,
        forbidden: [],
      });
    });
  }

  for (const file of files.filter((f) => f.endsWith('language-rules.md'))) {
    it(`${file} still tells the model what not to write`, () => {
      // The exemption above is only defensible while the file is actually the
      // vocabulary table. If it stops quoting the words, it stops being exempt.
      const text = read(file);
      expect(text).toContain('Never write');
      expect(findForbiddenClaims(text).length).toBeGreaterThan(3);
    });
  }
});

describe('the plugin hook is inside the claim scope too', () => {
  // The PreToolUse hook writes sentences about the law straight into a
  // session, which makes it a claim-bearing surface exactly like the CLI and
  // the skills -- and one that no reviewer reads as often, because it only
  // speaks when it fires.
  const hook = read('plugin/hooks/tracker-write-check.mjs');

  it('makes no forbidden claim', () => {
    expect(findForbiddenClaims(hook)).toEqual([]);
  });

  it('never emits a permission decision', () => {
    // Blocking an edit on a privacy heuristic would adjudicate, which is the
    // one thing this project refuses to do. Enforced here as well as in the
    // hook's own tests, because the temptation to "just block the bad one"
    // will come back.
    // Matches the key as it would be written into the output object, not the
    // word itself -- the hook's own comment explains why it never sets one, and
    // that explanation is worth keeping.
    expect(hook).not.toMatch(/permissionDecision\s*:/);
    expect(hook).not.toContain('"permissionDecision"');
  });

  it('sends the reader to the full review rather than concluding', () => {
    expect(hook).toContain('/privacy-review');
    expect(hook).toContain('not a conclusion about lawfulness');
  });
});

describe('a clean scan states what it did not check', () => {
  const clean = scan({
    root: 'fixtures/repos/clean-eu-only',
    toolVersion: '0.1.0',
    kbPath: 'kb',
    includeCallsites: true,
  });

  it('never presents zero findings as an all-clear', () => {
    const text = formatHuman(clean, { color: false });
    expect(text).toContain('not a statement that none exists');
    expect(text).toContain('Server-side proxying');
  });
});
