import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DISCLAIMER, NON_ASSESSMENT, findForbiddenClaims, scan, toSarif } from '@adequacy/core';
import { describe, expect, it } from 'vitest';
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
    expect(flat(read('skill/adequacy/SKILL.md'))).toContain(flat(DISCLAIMER));
  });

  it('the MCP server, which scopes every tool description', () => {
    const source = read('packages/mcp/src/server.ts');
    expect(source).toContain('const scoped =');
    expect(source).toContain('${DISCLAIMER}');
  });
});

describe('no generated output can claim compliance', () => {
  const surfaces: [string, string][] = [
    ['json', JSON.stringify(result)],
    ['sarif', JSON.stringify(toSarif(result, { toolVersion: '0.1.0' }))],
    ['markdown', formatMarkdown(result)],
    ['human', formatHuman(result, { color: false })],
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
    expect(findForbiddenClaims(read('skill/adequacy/SKILL.md'))).toEqual([]);
  });

  it('knowledge base entries contain no evaluative language', () => {
    for (const id of ['stripe', 'sentry', 'openai', 'mailgun', 'google-analytics']) {
      const entry = read(`kb/vendors/${id}.json`);
      expect({ id, forbidden: findForbiddenClaims(entry) }).toEqual({ id, forbidden: [] });
    }
  });
});

/**
 * Every markdown file shipped under `skill/`, found by walking the tree rather
 * than by a hand-maintained list.
 *
 * The list is computed on purpose. A hardcoded one lets the next specialist
 * checklist ship outside the contract simply by nobody remembering to add it,
 * which is the same drift this file exists to prevent -- one directory down.
 */
const skillMarkdown = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) out.push(path);
    }
  };
  walk('skill');
  return out.sort();
};

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
