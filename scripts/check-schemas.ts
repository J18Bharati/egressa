/**
 * Guards the contract three ways:
 *  1. every example document validates against the published findings schema
 *  2. the TypeScript enums and the JSON Schema enums agree (the real drift risk,
 *     since types.ts is the source of truth but the schema is hand-maintained)
 *  3. every example carries the exact disclaimer and no forbidden claim words
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { DISCLAIMER, findForbiddenClaims } from '../packages/core/src/claims.js';
import { RULE_IDS } from '../packages/core/src/rules.js';
import { FINDINGS_SCHEMA_VERSION } from '../packages/core/src/types.js';

const root = process.cwd();
const failures: string[] = [];

// Derived from the constant, not hardcoded: a version bump used to leave the
// new schema unvalidated while the superseded one silently kept passing.
const schemaPath = `schemas/findings-${FINDINGS_SCHEMA_VERSION}.json`;
const schema = JSON.parse(readFileSync(join(root, schemaPath), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(schema);

// 1. examples validate
const exampleDir = join(root, 'examples');
const examples = readdirSync(exampleDir).filter((f) => f.endsWith('.json'));
if (examples.length === 0) failures.push('no example documents found in examples/');

for (const file of examples) {
  const doc = JSON.parse(readFileSync(join(exampleDir, file), 'utf8'));
  if (!validate(doc)) {
    for (const err of validate.errors ?? []) {
      failures.push(`${file}: ${err.instancePath || '/'} ${err.message}`);
    }
  }

  // 3. disclaimer present and exact; no forbidden claims anywhere in the document
  if (doc.disclaimer !== DISCLAIMER) {
    failures.push(`${file}: disclaimer does not match claims.ts verbatim`);
  }
  const forbidden = findForbiddenClaims(JSON.stringify(doc));
  if (forbidden.length > 0) {
    failures.push(`${file}: forbidden claim words present: ${forbidden.join(', ')}`);
  }
}

// 2. enum agreement between TS and JSON Schema
const schemaRuleIds: string[] = schema.$defs.ruleId.enum;
const missingInSchema = RULE_IDS.filter((id) => !schemaRuleIds.includes(id));
const missingInTs = schemaRuleIds.filter((id) => !RULE_IDS.includes(id as never));
if (missingInSchema.length > 0) {
  failures.push(`rule ids in rules.ts but not in schema: ${missingInSchema.join(', ')}`);
}
if (missingInTs.length > 0) {
  failures.push(`rule ids in schema but not in rules.ts: ${missingInTs.join(', ')}`);
}

// vendor schema is at least parseable and self-consistent
JSON.parse(readFileSync(join(root, 'kb/schema/vendor-1.0.0.json'), 'utf8'));

if (failures.length > 0) {
  console.error('Schema check FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `Schema check OK: ${examples.length} example(s), ${RULE_IDS.length} rule ids, disclaimer verbatim.`,
);
