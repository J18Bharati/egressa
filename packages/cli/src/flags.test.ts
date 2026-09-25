import { describe, expect, it } from 'vitest';
import { scanCommand } from './commands/scan.js';
import { vendorsCommand } from './commands/vendors.js';
import { flagProblems } from './flags.js';

type Args = Parameters<typeof flagProblems>[1];
const scanArgs = scanCommand.args as Args;
const scan = (...argv: string[]) => flagProblems(['.', ...argv], scanArgs);
const ok = { unknown: [], missingValue: [] };

describe('a flag citty would drop is named', () => {
  it('catches a one-letter typo that used to widen the scan silently', () => {
    expect(scan('--exlude', 'legacy/**').unknown).toEqual(['--exlude']);
  });

  it('catches an unknown short flag', () => {
    expect(scan('-z').unknown).toEqual(['-z']);
  });

  it('catches every unknown flag, not only the first', () => {
    expect(scan('--nope', '--exclude', 'a', '--also-nope=1').unknown).toEqual([
      '--nope',
      '--also-nope=1',
    ]);
  });

  it('refuses the camelCase spelling, which citty accepts and then ignores', () => {
    // `--failOn note` exited 0 where `--fail-on note` exits 1: for a flag with a
    // default, citty reads the kebab key first and the camelCase value is lost.
    expect(scan('--failOn', 'note').unknown).toEqual(['--failOn']);
    expect(scan('--noDev').unknown).toEqual(['--noDev']);
    expect(scan('--minConfidence', 'high').unknown).toEqual(['--minConfidence']);
  });

  it('refuses a value on a boolean, which citty reads as a truthy string', () => {
    expect(scan('--quiet=false').unknown).toEqual(['--quiet=false']);
    expect(scan('--no-dev=true').unknown).toEqual(['--no-dev=true']);
  });

  it('refuses --no- on a string flag, which has no negation', () => {
    expect(scan('--no-exclude').unknown).toEqual(['--no-exclude']);
  });
});

describe('a string flag must actually receive its value', () => {
  it('reports a dash value as missing, since citty does not take it', () => {
    // `--exclude -legacy/**` scanned `-legacy/` anyway and exited 0.
    expect(scan('--exclude', '-legacy/**')).toEqual({
      unknown: ['-legacy/**'],
      missingValue: ['--exclude'],
    });
  });

  it('does not let a missing value hide the typo after it', () => {
    // `--only-vendor --exlude x` used to swallow `--exlude` as the vendor list.
    expect(scan('--only-vendor', '--exlude', 'x')).toEqual({
      unknown: ['--exlude'],
      missingValue: ['--only-vendor'],
    });
  });

  it('reports a string flag at the end of the line as missing its value', () => {
    expect(scan('--exclude').missingValue).toEqual(['--exclude']);
  });

  it('accepts a dash value written with =', () => {
    expect(scan('--exclude=-legacy/**')).toEqual(ok);
  });
});

describe('everything citty honours still passes', () => {
  it('accepts every declared flag in its declared spelling', () => {
    for (const [name, def] of Object.entries(scanArgs)) {
      if (def.type === 'positional') continue;
      const value = def.type === 'string' ? ['x'] : [];
      expect({ name, problems: scan(`--${name}`, ...value) }).toEqual({ name, problems: ok });
    }
  });

  it('accepts citty’s negation of every boolean', () => {
    for (const [name, def] of Object.entries(scanArgs)) {
      if (def.type !== 'boolean') continue;
      expect({ name, problems: scan(`--no-${name}`) }).toEqual({ name, problems: ok });
    }
  });

  it('accepts --name=value, --help and -h', () => {
    expect(scan('--fail-on=note', '--exclude=a/**', '--help', '-h')).toEqual(ok);
  });

  it('treats everything after -- as positional', () => {
    expect(scan('--', '--not-a-flag')).toEqual(ok);
  });

  it('accepts a declared alias', () => {
    const args = { format: { type: 'string', alias: ['f'] }, all: { type: 'boolean', alias: 'A' } };
    expect(flagProblems(['-f', 'json', '-A'], args as Args)).toEqual(ok);
  });

  it('checks each command against its own declarations', () => {
    const vendorsArgs = vendorsCommand.args as Args;
    expect(flagProblems(['list', '--json'], vendorsArgs)).toEqual(ok);
    expect(flagProblems(['list', '--format', 'json'], vendorsArgs).unknown).toEqual(['--format']);
  });
});
