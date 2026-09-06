import { DISCLAIMER, RULES, RULE_IDS } from '@adequacy/core';
import type { RuleId } from '@adequacy/core';
import { defineCommand } from 'citty';

export const explainCommand = defineCommand({
  meta: { name: 'explain', description: 'Explain a rule id' },
  args: {
    rule: {
      type: 'positional',
      required: false,
      description: 'Rule id, e.g. transfer/third-country-egress',
    },
  },
  run({ args }) {
    if (!args.rule) {
      for (const id of RULE_IDS) process.stdout.write(`${id}\n`);
      return;
    }
    const id = String(args.rule) as RuleId;
    const rule = RULES[id];
    if (!rule) {
      process.stderr.write(`adequacy: unknown rule "${id}"\n`);
      process.exit(2);
    }
    process.stdout.write(
      [
        rule.id,
        '',
        rule.shortDescription,
        '',
        rule.fullDescription,
        '',
        `Default level: ${rule.defaultLevel}`,
        '',
        rule.help,
        '',
        DISCLAIMER,
        '',
      ].join('\n'),
    );
  },
});
