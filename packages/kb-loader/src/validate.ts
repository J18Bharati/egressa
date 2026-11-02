import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdequacyStatus, VendorEntry } from './types.js';

/**
 * A knowledge base file that could not be read, parsed or validated.
 *
 * The CLI maps a failure to load the knowledge base to exit code 4. `file` and
 * `issues` are structured so a caller can report them its own way; `message`
 * already names the file and every JSON path, for the callers that do not.
 */
export class KnowledgeBaseError extends Error {
  override readonly name = 'KnowledgeBaseError';
  constructor(
    readonly file: string,
    readonly issues: string[],
  ) {
    super(
      issues.length === 1
        ? `${file}: ${issues[0]}`
        : `${file}:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new KnowledgeBaseError(file, [`could not be read: ${messageOf(error)}`]);
  }
}

// ---------------------------------------------------------------------------
// A checker driven by the published JSON Schemas
//
// The schemas in kb/schema/ are the single source of truth, and `pnpm
// kb:validate` checks the shipped data against them with Ajv. Ajv is not used
// here: compiling the vendor schema costs ~150 ms on every CLI start and
// ~285 KB in each bundled binary, for a loader that reads a few dozen small
// files. This reads the same schema files and turns the handful of keywords
// they use into closures, once.
//
// It fails closed. A keyword it does not implement throws while the schema is
// being compiled, whether or not any data reaches it, so a schema that grows a
// `format` or an `anyOf` stops loading until someone teaches this about it,
// rather than silently validating less. `schema-agreement.test.ts` holds it to
// Ajv's verdict over the shipped data and every single-edit mutation of it, so
// the two cannot drift unnoticed.
// ---------------------------------------------------------------------------

type Schema = { [keyword: string]: unknown };

/** Appends one message per way `value` fails, each prefixed with its JSON path. */
type Checker = (value: unknown, at: string, out: string[]) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keywords that annotate the schema and never decide validity. */
const ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description', 'default']);

const TYPE_TESTS = new Map<string, (value: unknown) => boolean>([
  ['object', isRecord],
  ['array', Array.isArray],
  ['string', (v) => typeof v === 'string'],
  ['number', (v) => typeof v === 'number' && Number.isFinite(v)],
  ['integer', (v) => typeof v === 'number' && Number.isInteger(v)],
  ['boolean', (v) => typeof v === 'boolean'],
  ['null', (v) => v === null],
]);

const typeName = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

const sameJson = (a: unknown, b: unknown) =>
  a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b));

const report = (at: string, out: string[], message: string) =>
  out.push(`${at === '' ? '(top level)' : at} ${message}`);

function unsupported(keyword: string): never {
  throw new Error(
    `knowledge base schema keyword "${keyword}" is not supported by the loader's checker; teach validate.ts about it`,
  );
}

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#/')) unsupported(`$ref ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    node = isRecord(node) ? node[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  if (!isRecord(node)) throw new Error(`knowledge base schema $ref ${ref} does not resolve`);
  return node;
}

function compile(root: Schema, schema: Schema, byRef: Map<string, Checker>): Checker {
  const checks: Checker[] = [];

  for (const [keyword, rule] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    switch (keyword) {
      case '$ref': {
        const ref = String(rule);
        // Registered before it is compiled, so a schema that refers to itself
        // terminates instead of recursing here.
        let target = byRef.get(ref);
        if (!target) {
          let compiled: Checker | undefined;
          target = (value, at, out) => compiled?.(value, at, out);
          byRef.set(ref, target);
          compiled = compile(root, resolveRef(root, ref), byRef);
        }
        checks.push(target);
        break;
      }
      case 'type': {
        const types = (Array.isArray(rule) ? rule : [rule]).map(String);
        const tests = types.map((t) => TYPE_TESTS.get(t) ?? unsupported(`type: ${t}`));
        const expected = types.join(' or ');
        checks.push((value, at, out) => {
          if (!tests.some((test) => test(value))) {
            report(at, out, `must be ${expected} (got ${typeName(value)})`);
          }
        });
        break;
      }
      case 'const':
        checks.push((value, at, out) => {
          if (!sameJson(rule, value)) {
            report(at, out, `must be equal to constant ${JSON.stringify(rule)}`);
          }
        });
        break;
      case 'enum': {
        if (!Array.isArray(rule)) unsupported('enum');
        const allowed = rule;
        checks.push((value, at, out) => {
          if (!allowed.some((candidate) => sameJson(candidate, value))) {
            report(
              at,
              out,
              `must be equal to one of the allowed values (allowed: ${allowed.join(', ')})`,
            );
          }
        });
        break;
      }
      case 'required': {
        if (!Array.isArray(rule)) unsupported('required');
        const keys = rule.map(String);
        checks.push((value, at, out) => {
          if (!isRecord(value)) return;
          for (const key of keys) {
            if (!Object.hasOwn(value, key)) report(at, out, `must have required property '${key}'`);
          }
        });
        break;
      }
      case 'properties': {
        if (!isRecord(rule)) unsupported('properties');
        const props = Object.entries(rule).map(([key, sub]) => {
          if (!isRecord(sub)) unsupported(`properties.${key}`);
          return [key, compile(root, sub, byRef)] as const;
        });
        checks.push((value, at, out) => {
          if (!isRecord(value)) return;
          for (const [key, check] of props) {
            if (Object.hasOwn(value, key)) check(value[key], `${at}/${key}`, out);
          }
        });
        break;
      }
      case 'additionalProperties': {
        if (rule === true) break;
        if (rule !== false) unsupported('additionalProperties (other than a boolean)');
        const known = isRecord(schema.properties) ? schema.properties : {};
        checks.push((value, at, out) => {
          if (!isRecord(value)) return;
          for (const key of Object.keys(value)) {
            if (!Object.hasOwn(known, key)) {
              report(at, out, `must NOT have additional property '${key}'`);
            }
          }
        });
        break;
      }
      case 'items': {
        if (!isRecord(rule)) unsupported('items (other than a schema)');
        const each = compile(root, rule, byRef);
        checks.push((value, at, out) => {
          if (!Array.isArray(value)) return;
          for (let i = 0; i < value.length; i++) each(value[i], `${at}/${i}`, out);
        });
        break;
      }
      case 'minItems':
        checks.push((value, at, out) => {
          if (Array.isArray(value) && value.length < Number(rule)) {
            report(at, out, `must have at least ${rule} item${rule === 1 ? '' : 's'}`);
          }
        });
        break;
      case 'minLength':
        checks.push((value, at, out) => {
          if (typeof value === 'string' && Array.from(value).length < Number(rule)) {
            report(at, out, `must be at least ${rule} character${rule === 1 ? '' : 's'} long`);
          }
        });
        break;
      case 'maxLength':
        checks.push((value, at, out) => {
          if (typeof value === 'string' && Array.from(value).length > Number(rule)) {
            report(at, out, `must be at most ${rule} characters long`);
          }
        });
        break;
      case 'pattern': {
        const pattern = new RegExp(String(rule), 'u');
        checks.push((value, at, out) => {
          if (typeof value === 'string' && !pattern.test(value)) {
            report(at, out, `must match pattern "${rule}"`);
          }
        });
        break;
      }
      case 'oneOf': {
        if (!Array.isArray(rule)) unsupported('oneOf');
        const shapes = rule.map((sub) => {
          if (!isRecord(sub)) unsupported('oneOf (other than schemas)');
          return compile(root, sub, byRef);
        });
        checks.push((value, at, out) => {
          const passing = shapes.filter((shape) => {
            const scratch: string[] = [];
            shape(value, at, scratch);
            return scratch.length === 0;
          });
          if (passing.length !== 1) report(at, out, 'must match exactly one allowed shape');
        });
        break;
      }
      case 'if': {
        if (!isRecord(rule)) unsupported('if (other than a schema)');
        if (!isRecord(schema.then)) unsupported('if without then');
        const condition = compile(root, rule, byRef);
        const consequence = compile(root, schema.then, byRef);
        checks.push((value, at, out) => {
          const scratch: string[] = [];
          condition(value, at, scratch);
          if (scratch.length === 0) consequence(value, at, out);
        });
        break;
      }
      case 'then':
        // Applied together with its `if`, above.
        if (!Object.hasOwn(schema, 'if')) unsupported('then without if');
        break;
      default:
        unsupported(keyword);
    }
  }

  return (value, at, out) => {
    for (const check of checks) check(value, at, out);
  };
}

/** Every way `value` fails `schema`; empty when it conforms. */
export function schemaIssues(schema: Schema, value: unknown): string[] {
  const out: string[] = [];
  compile(schema, schema, new Map())(value, '', out);
  return out;
}

/** Past this many, further issues are summarised: one bad file can raise hundreds. */
const MAX_ISSUES = 8;

function capped(issues: string[]): string[] {
  if (issues.length <= MAX_ISSUES) return issues;
  return [...issues.slice(0, MAX_ISSUES), `... and ${issues.length - MAX_ISSUES} more`];
}

/** Compiled once per schema file for the life of the process. */
const compiled = new Map<string, Checker>();

function checkerFor(schemaPath: string): Checker {
  const known = compiled.get(schemaPath);
  if (known) return known;
  const parsed: unknown = JSON.parse(readText(schemaPath));
  if (!isRecord(parsed)) throw new Error(`knowledge base schema ${schemaPath} is not an object`);
  const checker = compile(parsed, parsed, new Map());
  compiled.set(schemaPath, checker);
  return checker;
}

/**
 * Reads a JSON file and checks it against a schema.
 *
 * The one place a parsed file becomes a domain type. `conforms` is a type
 * predicate, so the narrowing is the schema's own verdict rather than an
 * assertion of ours.
 */
function readValidated<T>(
  file: string,
  conforms: (value: unknown, issues: string[]) => value is T,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(file));
  } catch (error) {
    if (error instanceof KnowledgeBaseError) throw error;
    throw new KnowledgeBaseError(file, [`is not valid JSON: ${messageOf(error)}`]);
  }
  const issues: string[] = [];
  if (!conforms(parsed, issues)) throw new KnowledgeBaseError(file, capped(issues));
  return parsed;
}

const conformsTo =
  <T>(schemaPath: string) =>
  (value: unknown, issues: string[]): value is T => {
    checkerFor(schemaPath)(value, '', issues);
    return issues.length === 0;
  };

/**
 * `schemaDir` is the copy of the schemas shipped with this tool, never one
 * beside the data being loaded. `--kb` exists to read a knowledge base somebody
 * else wrote; one carrying its own permissive schema would otherwise vouch for
 * itself.
 */
export const readVendor = (file: string, schemaDir: string) =>
  readValidated(file, conformsTo<VendorEntry>(join(schemaDir, 'vendor-1.0.0.json')));

export const readAdequacy = (file: string, schemaDir: string) =>
  readValidated(file, conformsTo<AdequacyStatus>(join(schemaDir, 'adequacy-status-1.0.0.json')));
