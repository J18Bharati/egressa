import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../scan.js';
import {
  isDevRequirementsFile,
  normalisePypiName,
  parsePyprojectToml,
  parseRequirementsTxt,
} from './python.js';

const names = (result: { dependencies: { name: string; dev: boolean }[] }) =>
  result.dependencies.map((d) => (d.dev ? `${d.name} (dev)` : d.name));

describe('PEP 503 names', () => {
  it('normalises case and separator runs', () => {
    expect(normalisePypiName('Twilio')).toBe('twilio');
    expect(normalisePypiName('Sentry_SDK')).toBe('sentry-sdk');
    expect(normalisePypiName('zope.interface')).toBe('zope-interface');
    expect(normalisePypiName('a__-.b')).toBe('a-b');
  });
});

describe('requirements.txt', () => {
  it('reads names, extras, specifiers, markers and direct references', () => {
    const text = [
      'twilio>=9.0.0',
      'Boto3 == 1.34.0  # pinned for the SES client',
      'requests[security,socks]~=2.31',
      'httpx ; python_version >= "3.9"',
      'mypkg @ https://example.com/mypkg-1.0.tar.gz',
    ].join('\n');
    expect(names(parseRequirementsTxt(text, 'requirements.txt'))).toEqual([
      'twilio',
      'boto3',
      'requests',
      'httpx',
      'mypkg',
    ]);
  });

  it('refuses lines that name no project rather than guessing one', () => {
    const text = [
      '# a comment',
      '-r base.txt',
      '-e ./local-package',
      '--index-url https://pypi.example.com/simple',
      'git+https://github.com/org/repo.git#egg=repo',
      'https://example.com/pkg.whl',
      './vendor/pkg.tar.gz',
      '',
    ].join('\n');
    expect(parseRequirementsTxt(text, 'requirements.txt').dependencies).toEqual([]);
  });

  it('points at the name as written', () => {
    const text = 'flask\n  Twilio>=9\n';
    const twilio = parseRequirementsTxt(text, 'requirements.txt').dependencies[1];
    expect(twilio?.loc).toMatchObject({ startLine: 2, startColumn: 3, endColumn: 9 });
    expect(twilio?.ecosystem).toBe('pypi');
    expect(twilio?.direct).toBe(true);
  });

  it('marks a dev requirements file as dev by its name', () => {
    expect(isDevRequirementsFile('requirements.txt')).toBe(false);
    expect(isDevRequirementsFile('requirements-dev.txt')).toBe(true);
    expect(isDevRequirementsFile('svc/requirements_test.txt')).toBe(true);
    expect(isDevRequirementsFile('requirements/lint.txt')).toBe(true);
    expect(isDevRequirementsFile('requirements/base.txt')).toBe(false);
    expect(isDevRequirementsFile('requirements-devops.txt')).toBe(false);
  });
});

describe('pyproject.toml', () => {
  it('reads PEP 621 dependencies across lines, and extras', () => {
    const text = [
      '[project]',
      'name = "example-service"',
      'dependencies = [',
      '  "twilio>=9.0.0",  # SMS',
      "  'boto3',",
      ']',
      '',
      '[project.optional-dependencies]',
      'aws = ["botocore>=1.34"]',
      'dev = ["pytest"]',
    ].join('\n');
    expect(names(parsePyprojectToml(text, 'pyproject.toml'))).toEqual([
      'twilio',
      'boto3',
      'botocore',
      'pytest (dev)',
    ]);
  });

  it('reads PEP 735 dependency groups as dev', () => {
    const text = '[dependency-groups]\ntest = ["pytest", "moto[s3]"]\n';
    expect(names(parsePyprojectToml(text, 'pyproject.toml'))).toEqual([
      'pytest (dev)',
      'moto (dev)',
    ]);
  });

  it('reads Poetry tables, one package per key, and skips python', () => {
    const text = [
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'Twilio = "^9.0"',
      'boto3 = { version = "^1.34", optional = true }',
      '',
      '[tool.poetry.group.dev.dependencies]',
      'pytest = "^8"',
    ].join('\n');
    expect(names(parsePyprojectToml(text, 'pyproject.toml'))).toEqual([
      'twilio',
      'boto3',
      'pytest (dev)',
    ]);
  });

  it('ignores tables that do not declare dependencies', () => {
    const text = [
      '[tool.ruff]',
      'select = ["E", "F"]',
      '[project]',
      'keywords = ["twilio"]',
      '[tool.mypy]',
      'dependencies = ["not-a-dependency"]',
    ].join('\n');
    expect(parsePyprojectToml(text, 'pyproject.toml').dependencies).toEqual([]);
  });

  it('points at the name inside the string', () => {
    const text = '[project]\ndependencies = [\n    "twilio>=9",\n]\n';
    const [twilio] = parsePyprojectToml(text, 'pyproject.toml').dependencies;
    expect(twilio?.loc).toMatchObject({ startLine: 3, startColumn: 6, endColumn: 12 });
  });
});

describe('a Python service is scanned end to end', () => {
  it('attributes a declared vendor SDK, and never reads a virtualenv', () => {
    // The field-test case: twilio, a vendor already in the knowledge base, was
    // missed in five production files because no Python manifest was read.
    const root = mkdtempSync(join(tmpdir(), 'egressa-python-'));
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[project]\nname = "svc"\ndependencies = ["twilio>=9.0.0", "boto3"]\n',
    );
    // An installed package's own manifest describes what *it* uses.
    mkdirSync(join(root, '.venv', 'lib', 'site-packages', 'x'), { recursive: true });
    writeFileSync(join(root, '.venv', 'lib', 'site-packages', 'x', 'requirements.txt'), 'stripe\n');

    const result = scan({ root, toolVersion: '0.0.0', kbPath: 'kb' });
    const vendors = result.findings.map((f) => f.vendor?.id).sort();
    expect(vendors).toEqual(['aws', 'twilio']);
    const twilio = result.findings.find((f) => f.vendor?.id === 'twilio');
    expect(twilio?.confidence).toBe('high');
    expect(twilio?.evidence[0]).toMatchObject({ kind: 'dependency', file: 'pyproject.toml' });
  });
});
