import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../scan.js';
import {
  isDevRequirementsFile,
  isRequirementsFile,
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

describe('what the branch review found reading as a dependency', () => {
  // Each of these reported a vendor at high confidence that the file does not
  // declare as a dependency.
  const pyproject = (text: string) => names(parsePyprojectToml(text, 'pyproject.toml'));

  it('ends a dependency table at an array-of-tables header', () => {
    const text = [
      '[project.optional-dependencies]',
      'aws = ["boto3"]',
      '[[tool.mypy.overrides]]',
      'module = ["twilio", "boto3"]',
    ].join('\n');
    expect(pyproject(text)).toEqual(['boto3']);
  });

  it('does not read a Poetry source block as packages', () => {
    const text = [
      '[tool.poetry.dependencies]',
      'twilio = "^9"',
      '[[tool.poetry.source]]',
      'name = "private"',
      'url = "https://pypi.example.com/simple"',
      'priority = "supplemental"',
    ].join('\n');
    expect(pyproject(text)).toEqual(['twilio']);
  });

  it('never reads inside a multi-line string', () => {
    expect(pyproject('[project]\ndescription = """\ndependencies = ["twilio"]\n"""\n')).toEqual([]);
    expect(pyproject("[tool.poetry.dependencies]\nreadme = '''\ntwilio = \"yes\"\n'''\n")).toEqual([
      'readme',
    ]);
    expect(pyproject('[project]\ndependencies = ["""twilio"""]\n')).toEqual([]);
  });

  it('recognises a header with a trailing comment on a CRLF line', () => {
    const text =
      '[project]\r\ndependencies = []\r\n[tool.pytest.ini_options]  # cfg\r\naddopts = ["twilio"]\r\n';
    expect(pyproject(text)).toEqual([]);
  });

  it('names the package in a Poetry dotted key, once per line', () => {
    const text = '[tool.poetry.dependencies]\nboto3.version = "^1"\nboto3.optional = true\n';
    expect(pyproject(text)).toEqual(['boto3', 'boto3']);
  });

  it('does not read a PEP 735 include-group as a package', () => {
    const text =
      '[dependency-groups]\ntest = ["pytest"]\nci = [{ include-group = "test" }, "coverage"]\n';
    expect(pyproject(text)).toEqual(['pytest (dev)', 'coverage (dev)']);
  });

  it('marks a named Poetry group dev only when it is named like one', () => {
    const text =
      '[tool.poetry.group.aws.dependencies]\nboto3 = "^1"\n[tool.poetry.group.test.dependencies]\npytest = "^8"\n';
    expect(pyproject(text)).toEqual(['boto3', 'pytest (dev)']);
  });

  it('reads a requirement line ending in CRLF', () => {
    expect(names(parseRequirementsTxt('twilio  # sms\r\n', 'requirements.txt'))).toEqual([
      'twilio',
    ]);
  });

  it('refuses prose that starts with a project name', () => {
    expect(
      parseRequirementsTxt('Twilio (for SMS) is used\n', 'requirements.txt').dependencies,
    ).toEqual([]);
    expect(names(parseRequirementsTxt('twilio (>=9.0)\n', 'requirements.txt'))).toEqual(['twilio']);
  });

  it('never reads a pip-compile continuation as a requirement', () => {
    const text =
      'twilio==9.0.0 \\\n    --hash=sha256:abc \\\n    --hash=sha256:def\nboto3==1.34 \\\n    --hash=sha256:123\n';
    expect(names(parseRequirementsTxt(text, 'requirements.txt'))).toEqual(['twilio', 'boto3']);
  });

  it('reads only files that are requirements files', () => {
    expect(isRequirementsFile('requirements.txt')).toBe(true);
    expect(isRequirementsFile('svc/requirements-prod.txt')).toBe(true);
    expect(isRequirementsFile('requirements/base.txt')).toBe(true);
    expect(isRequirementsFile('requirements/README.txt')).toBe(false);
    expect(isRequirementsFile('requirements/constraints.txt')).toBe(false);
    expect(isRequirementsFile('constraints.txt')).toBe(false);
    expect(isRequirementsFile('docs/notes.txt')).toBe(false);
  });

  it('marks dev files whatever their case', () => {
    expect(isDevRequirementsFile('requirements-DEV.txt')).toBe(true);
  });
});

describe('a Python service is scanned end to end', () => {
  const write = (root: string, rel: string, text: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  it('attributes a declared vendor SDK at high confidence', () => {
    // The field-test case: twilio, a vendor already in the knowledge base, was
    // missed in five production files because no Python manifest was read.
    const root = mkdtempSync(join(tmpdir(), 'egressa-python-'));
    write(root, 'pyproject.toml', '[project]\nname = "svc"\ndependencies = ["twilio>=9.0.0"]\n');
    const result = scan({ root, toolVersion: '0.0.0', kbPath: 'kb' });
    const twilio = result.findings.find((f) => f.vendor?.id === 'twilio');
    expect(twilio?.confidence).toBe('high');
    expect(twilio?.evidence[0]).toMatchObject({ kind: 'dependency', file: 'pyproject.toml' });
  });

  // An installed package's own manifest describes what *it* uses, and an
  // editable install's pyproject.toml reads as this repository's own. Each case
  // plants a knowledge base vendor, so a missing exclusion fails the test.
  const installed: Array<[string, string]> = [
    ['a virtualenv named venv', 'venv/lib/python3.12/site-packages/x/requirements.txt'],
    ['site-packages anywhere', 'lib/site-packages/x/requirements.txt'],
    ['Debian dist-packages', 'usr/lib/python3/dist-packages/x/requirements.txt'],
    ['PEP 582 __pypackages__', '__pypackages__/3.12/lib/x/requirements.txt'],
    ['a dot directory', '.venv/src/x/requirements.txt'],
  ];
  for (const [label, rel] of installed) {
    it(`never reads ${label}`, () => {
      const root = mkdtempSync(join(tmpdir(), 'egressa-python-'));
      write(root, rel, 'twilio\n');
      const result = scan({ root, toolVersion: '0.0.0', kbPath: 'kb' });
      expect(result.findings.map((f) => f.vendor?.id)).toEqual([]);
    });
  }

  it('prunes a virtualenv by its pyvenv.cfg, whatever it is named', () => {
    const root = mkdtempSync(join(tmpdir(), 'egressa-python-'));
    write(root, 'env/pyvenv.cfg', 'home = /usr/bin\n');
    write(root, 'env/src/editable-dep/pyproject.toml', '[project]\ndependencies = ["twilio"]\n');
    write(root, 'requirements.txt', 'boto3\n');
    const result = scan({ root, toolVersion: '0.0.0', kbPath: 'kb' });
    expect(result.findings.map((f) => f.vendor?.id)).toEqual(['aws']);
  });
});
