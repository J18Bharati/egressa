import { describe, expect, it } from 'vitest';
import { scanCommand } from './commands/scan.js';
import { vendorsCommand } from './commands/vendors.js';
import { unknownFlags } from './flags.js';

const scanArgs = scanCommand.args as Parameters<typeof unknownFlags>[1];
const scan = (...argv: string[]) => unknownFlags(['.', ...argv], scanArgs);

describe('a flag the command does not declare is named', () => {
  it('catches a one-letter typo that used to widen the scan silently', () => {
    expect(scan('--exlude', 'legacy/**')).toEqual(['--exlude']);
  });

  it('catches an unknown short flag', () => {
    expect(scan('-z')).toEqual(['-z']);
  });

  it('catches every unknown flag, not only the first', () => {
    expect(scan('--nope', '--exclude', 'a', '--also-nope=1')).toEqual(['--nope', '--also-nope']);
  });
});

describe('everything the command accepts still passes', () => {
  it('accepts every declared flag, in both spellings', () => {
    for (const [name, def] of Object.entries(scanArgs)) {
      if (def.type === 'positional') continue;
      const value = def.type === 'string' ? ['x'] : [];
      const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      expect({ name, bad: scan(`--${name}`, ...value) }).toEqual({ name, bad: [] });
      expect({ camel, bad: scan(`--${camel}`, ...value) }).toEqual({ camel, bad: [] });
    }
  });

  it('accepts citty’s negation of every boolean', () => {
    for (const [name, def] of Object.entries(scanArgs)) {
      if (def.type !== 'boolean') continue;
      expect({ name, bad: scan(`--no-${name}`) }).toEqual({ name, bad: [] });
    }
  });

  it('accepts --name=value, --help and -h', () => {
    expect(scan('--fail-on=note', '--exclude=a/**', '--help', '-h')).toEqual([]);
  });

  it('does not read a string flag’s value as a flag', () => {
    expect(scan('--exclude', '-weird-dir/**')).toEqual([]);
  });

  it('treats everything after -- as positional', () => {
    expect(scan('--', '--not-a-flag')).toEqual([]);
  });

  it('checks each command against its own declarations', () => {
    const vendorsArgs = vendorsCommand.args as Parameters<typeof unknownFlags>[1];
    expect(unknownFlags(['list', '--json'], vendorsArgs)).toEqual([]);
    expect(unknownFlags(['list', '--format', 'json'], vendorsArgs)).toEqual(['--format']);
  });
});
