import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { schemaIssues } from './validate.js';

/**
 * The loader checks files against the published schemas with its own small
 * interpreter (see validate.ts for why it is not Ajv). `pnpm kb:validate` uses
 * Ajv. These tests hold the two to the same verdict, over the shipped data and
 * over every single-edit mutation of it, so the interpreter cannot quietly
 * accept what the validator rejects.
 */

// Mutated documents are deliberately the wrong shape.
// biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON, edited in place
type Json = any;

const loadJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'));

const subjects = [
  {
    schemaFile: 'vendor-1.0.0.json',
    docs: readdirSync(join('kb', 'vendors')).map((f) => loadJson(join('kb', 'vendors', f))),
  },
  {
    schemaFile: 'adequacy-status-1.0.0.json',
    docs: [loadJson(join('kb', 'adequacy-status.json'))],
  },
];

type Path = (string | number)[];

function pathsOf(doc: Json): Path[] {
  const paths: Path[] = [];
  const walk = (node: Json, path: Path) => {
    paths.push(path);
    if (Array.isArray(node)) node.forEach((x, i) => walk(x, [...path, i]));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  };
  walk(doc, []);
  return paths;
}

function at(doc: Json, path: Path): Json {
  let node = doc;
  for (const key of path) node = node[key];
  return node;
}

/** Every single-edit mutation of `doc`: delete, retype or extend each node in turn. */
function* mutations(doc: Json): Generator<Json> {
  const paths = pathsOf(doc);
  for (const path of paths) {
    const parentPath = path.slice(0, -1);
    const key = path[path.length - 1];
    for (const replacement of [42, '', 'not-an-allowed-value', null, true, [], {}]) {
      if (path.length === 0) {
        yield replacement;
        continue;
      }
      const copy = structuredClone(doc);
      at(copy, parentPath)[key as string] = replacement;
      yield copy;
    }
    if (path.length > 0) {
      const copy = structuredClone(doc);
      const parent = at(copy, parentPath);
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key as string];
      yield copy;
    }
  }
  // Extra keys, including names an object also inherits: `in` would call these known.
  for (const path of paths) {
    for (const extra of ['unexpected', 'constructor', 'toString', '__proto__']) {
      const copy = structuredClone(doc);
      const node = at(copy, path);
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        Object.defineProperty(node, extra, { value: 1, enumerable: true, configurable: true });
        yield copy;
      }
    }
  }
}

describe('the loader’s checker gives the verdict Ajv gives', () => {
  for (const { schemaFile, docs } of subjects) {
    it(`on ${schemaFile}, for the shipped data and every one-edit mutation of it`, () => {
      const schema = loadJson(join('kb', 'schema', schemaFile));
      const ajvValid = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
      let checked = 0;
      let rejected = 0;
      for (const doc of docs) {
        for (const variant of [doc, ...mutations(doc)]) {
          const expected = ajvValid(variant);
          const issues = schemaIssues(schema, variant);
          if ((issues.length === 0) !== expected) {
            throw new Error(
              `disagreement (ajv says ${expected ? 'valid' : 'invalid'}): ${JSON.stringify(variant).slice(0, 300)}\n${issues.join('\n')}`,
            );
          }
          checked++;
          if (!expected) rejected++;
        }
      }
      // Both verdicts must be exercised, or agreement proves nothing.
      expect(checked).toBeGreaterThan(500);
      expect(rejected).toBeGreaterThan(100);
      expect(checked - rejected).toBeGreaterThan(0);
    }, 60_000);
  }

  it('fails closed on a schema keyword it does not implement', () => {
    expect(() => schemaIssues({ type: 'string', format: 'uri' }, 'x')).toThrow(/format/);
    expect(() => schemaIssues({ anyOf: [] }, 'x')).toThrow(/anyOf/);
    expect(() => schemaIssues({ additionalProperties: { type: 'string' } }, {})).toThrow(
      /additionalProperties/,
    );
  });
});
