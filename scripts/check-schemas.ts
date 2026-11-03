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
import { FACT_KINDS } from '../packages/core/src/facts/load.js';
import { RULE_IDS } from '../packages/core/src/rules.js';
import {
  FACT_EFFECTS,
  FINDINGS_SCHEMA_VERSION,
  REPOSITORY_FACT_KINDS,
  SIGNAL_KINDS,
} from '../packages/core/src/types.js';
import { VERIFY_FACTS, VERIFY_REASONS } from '../packages/kb-loader/src/tasks.js';

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

// Signal kinds, for the same reason and by the same route. This was hand-synced
// until `reference` was added: the header above has always claimed the TS and
// JSON enums agree, and only the rule ids were ever compared, so a kind added on
// one side and forgotten on the other passed the check that exists to catch it.
const schemaSignalKinds: string[] = schema.$defs.signalKind.enum;
const kindsMissingInSchema = SIGNAL_KINDS.filter((k) => !schemaSignalKinds.includes(k));
const kindsMissingInTs = schemaSignalKinds.filter((k) => !SIGNAL_KINDS.includes(k as never));
if (kindsMissingInSchema.length > 0) {
  failures.push(`signal kinds in types.ts but not in schema: ${kindsMissingInSchema.join(', ')}`);
}
if (kindsMissingInTs.length > 0) {
  failures.push(`signal kinds in schema but not in types.ts: ${kindsMissingInTs.join(', ')}`);
}

// Verification task vocabularies, for the same reason again.
for (const [label, ts, json] of [
  ['verification facts', VERIFY_FACTS, schema.$defs.verifyTask.properties.fact.enum],
  ['verification reasons', VERIFY_REASONS, schema.$defs.verifyTask.properties.reason.enum],
  // Repository fact vocabularies: the findings schema, and the facts file's own schema.
  ['fact effects', FACT_EFFECTS, schema.$defs.repositoryFact.properties.effect.enum],
  [
    'repository fact kinds',
    REPOSITORY_FACT_KINDS,
    schema.$defs.repositoryFact.properties.fact.enum,
  ],
  [
    'facts file fact kinds',
    FACT_KINDS,
    JSON.parse(readFileSync(join(root, 'kb/schema/facts-1.0.0.json'), 'utf8')).$defs.fact.properties
      .fact.enum,
  ],
] as [string, readonly string[], string[]][]) {
  const notInSchema = ts.filter((v) => !json.includes(v));
  const notInTs = json.filter((v) => !ts.includes(v));
  if (notInSchema.length > 0)
    failures.push(`${label} in code but not in schema: ${notInSchema.join(', ')}`);
  if (notInTs.length > 0)
    failures.push(`${label} in schema but not in code: ${notInTs.join(', ')}`);
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
