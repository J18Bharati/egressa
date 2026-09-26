import { describe, expect, it } from 'vitest';
import { regionsFromKeyLiterals } from './key-literal.js';

const tf = (text: string, provider = 'aws') =>
  regionsFromKeyLiterals(text, 'main.tf', ['region'], provider, {
    language: 'hcl',
    insideBlockNamed: 'provider',
  });
const fly = (text: string) =>
  regionsFromKeyLiterals(text, 'fly.toml', ['primary_region'], 'fly', { language: 'toml' });
const regions = (records: { region: string }[]) => records.map((r) => r.region);

/** 1-based column of the first `needle` on 1-based `line`. */
const columnOf = (text: string, line: number, needle: string) =>
  (text.split('\n')[line - 1] ?? '').indexOf(needle) + 1;

describe('only the provider block’s own level is read', () => {
  it('ignores a region tag nested in default_tags', () => {
    // Ordinary Terraform. The tag used to become a second AWS finding titled
    // "(emea)" at high confidence, pointing at a tag value.
    const text = [
      'provider "aws" {',
      '  default_tags {',
      '    tags = { region = "emea" }',
      '  }',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });

  it('ignores the nested tag when the whole block is on one line', () => {
    const text =
      'provider "aws" { default_tags { tags = { region = "emea" } } region = "eu-west-1" }';
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });

  it('applies the same rule to a second provider', () => {
    const text = [
      'provider "gcp" {',
      '  region = "europe-west1"',
      '  labels {',
      '    region = "x"',
      '  }',
      '}',
    ].join('\n');
    const records = tf(text, 'gcp');
    expect(records.map((r) => [r.provider, r.region])).toEqual([['gcp', 'europe-west1']]);
  });
});

describe('the key must stand alone', () => {
  it('does not read sts_region as the region', () => {
    // A real argument of the AWS provider.
    expect(tf('provider "aws" {\n  sts_region = "us-east-1"\n}')).toEqual([]);
  });

  it('reads region beside sts_region, and only region', () => {
    const text = 'provider "aws" {\n  sts_region = "us-east-1"\n  region = "eu-west-1"\n}';
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });

  it('does not read a hyphenated key ending in region', () => {
    // HCL identifiers and TOML bare keys may both contain `-`.
    expect(tf('provider "aws" {\n  x-region = "us-east-1"\n}')).toEqual([]);
  });
});

describe('only code counts, not strings or comments', () => {
  // Each of these reported a region the file does not declare, after the
  // first rewrite started reading every match on a line.
  it('ignores a region in a trailing comment', () => {
    const text = 'provider "aws" {\n  region = "eu-west-1" # was region = "us-east-1"\n}';
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });

  it('ignores a commented default after a variable', () => {
    const text = 'provider "aws" {\n  region = var.region // default region = "us-east-1"\n}';
    expect(tf(text)).toEqual([]);
  });

  it('ignores a region in a trailing comment in fly.toml', () => {
    const records = fly('primary_region = "ams" # primary_region = "iad"\n');
    expect(records.map((r) => r.region)).toEqual(['ams']);
  });

  it('ignores a block comment, including one spanning lines', () => {
    const text = [
      'provider "aws" {',
      '  /* region = "us-east-1" */ region = "eu-west-1"',
      '  /*',
      '  region = "us-west-2"',
      '  */',
      '}',
    ].join('\n');
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });

  it('does not let braces inside a tag value move the depth', () => {
    // `}}` in a string made the nested tag read as the provider's own region,
    // and dropped the real one.
    const text = [
      'provider "aws" {',
      '  default_tags {',
      '    tags = { note = "}}", region = "emea" }',
      '  }',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });

  it('does not leave the block early on a lone brace in a string', () => {
    const text = [
      'provider "aws" {',
      '  default_tags {',
      '    tags = { Owner = "team}" }',
      '  }',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });

  it('does not count braces inside an interpolation', () => {
    const text = [
      'provider "aws" {',
      '  profile = "${lookup(var.profiles, "a")}-${var.env}"',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });

  it('ends the block at the brace that closes it, not at the end of the line', () => {
    const text =
      'provider "aws" {\n  region = "eu-west-1" }  resource "x" "y" { region = "us-east-1" }';
    expect(tf(text).map((r) => r.region)).toEqual(['eu-west-1']);
  });
});

describe('what the rewrite must keep doing', () => {
  it('reads fly.toml primary_region, attributed to fly', () => {
    const records = fly('app = "demo"\nprimary_region = "ams"\n');
    expect(records.map((r) => [r.provider, r.region])).toEqual([['fly', 'ams']]);
  });

  it('reads a one-line provider block', () => {
    expect(tf('provider "aws" { region = "ca-central-1" }').map((r) => r.region)).toEqual([
      'ca-central-1',
    ]);
  });

  it('points at the key on a multi-line block', () => {
    const text = 'provider "aws" {\n  region = "eu-west-1"\n}';
    const [record] = tf(text);
    expect(record?.loc).toMatchObject({
      startLine: 2,
      startColumn: columnOf(text, 2, 'region'),
      endColumn: columnOf(text, 2, 'region') + 'region'.length,
    });
  });

  it('points at the key on a one-line block', () => {
    const text = 'provider "aws" { region = "ca-central-1" }';
    const [record] = tf(text);
    expect(record?.loc).toMatchObject({ startLine: 1, startColumn: columnOf(text, 1, 'region') });
  });

  it('points at the real key when an ignored nested one precedes it on the line', () => {
    const text =
      'provider "aws" { default_tags { tags = { region = "emea" } } region = "eu-west-1" }';
    const [record] = tf(text);
    expect(record?.loc.startColumn).toBe(text.lastIndexOf('region') + 1);
  });

  it('skips commented-out assignments', () => {
    const text = 'provider "aws" {\n  # region = "us-east-1"\n  // region = "us-west-2"\n}';
    expect(tf(text)).toEqual([]);
  });

  it('refuses a value that is not a quoted literal', () => {
    expect(tf('provider "aws" {\n  region = var.region\n}')).toEqual([]);
    expect(tf('provider "aws" {\n  region = "${var.region}"\n}')).toEqual([]);
  });

  it('does not cross two providers in one file', () => {
    const text = [
      'provider "gcp" {',
      '  region = "europe-west1"',
      '}',
      'provider "aws" {',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(tf(text, 'aws').map((r) => r.region)).toEqual(['eu-west-1']);
    expect(tf(text, 'gcp').map((r) => r.region)).toEqual(['europe-west1']);
  });
});

describe('what is not code on this line may have been opened on an earlier one', () => {
  // Field test 3, A9. Each of these reported a region the file does not declare,
  // because only a block comment used to carry from one line to the next.
  it('does not read a heredoc body inside the provider', () => {
    const text = [
      'provider "aws" {',
      '  profile = <<EOF',
      'region = "us-east-1"',
      'EOF',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(regions(tf(text))).toEqual(['eu-west-1']);
  });

  it('does not read an indented heredoc body', () => {
    const text = [
      'provider "aws" {',
      '  profile = <<-EOT',
      '    region = "ap-south-1"',
      '  EOT',
      '}',
    ].join('\n');
    expect(tf(text)).toEqual([]);
  });

  it('does not read a provider block that a heredoc writes', () => {
    // Terraform that writes Terraform. This one was reported at high
    // confidence and narrowed the jurisdiction to the United States.
    const text = [
      'resource "local_file" "p" {',
      '  content = <<EOF',
      'provider "aws" {',
      '  region = "us-west-2"',
      '}',
      'EOF',
      '}',
    ].join('\n');
    expect(tf(text)).toEqual([]);
  });

  it('does not let a brace in a heredoc move the depth', () => {
    const text = [
      'provider "aws" {',
      '  assume_role {',
      '    policy = <<EOF',
      '}',
      'EOF',
      '    region = "us-east-1"',
      '  }',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(regions(tf(text))).toEqual(['eu-west-1']);
  });

  it('does not close a string on a quote inside a template directive', () => {
    // A7's exact symptom, brought back by `%{`.
    const text = [
      'provider "aws" {',
      '  default_tags {',
      '    tags = {',
      '      n = "%{ for k in ["}"] }${k}%{ endfor }"',
      '      m = "%{ for k in ["}"] }${k}%{ endfor }"',
      '      region = "emea"',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(tf(text)).toEqual([]);
  });

  it('carries an interpolation across lines', () => {
    const text = [
      'provider "aws" {',
      '  default_tags {',
      '    tags = {',
      '      n = "${',
      '        lookup(var.m, "}")',
      '      }"',
      '      region = "emea"',
      '    }',
      '  }',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(regions(tf(text))).toEqual(['eu-west-1']);
  });

  it('opens nothing on the $${ and %%{ escapes', () => {
    const text = [
      'provider "aws" {',
      '  profile = "$${region} %%{x}"',
      '  region = "eu-west-1"',
      '}',
    ].join('\n');
    expect(regions(tf(text))).toEqual(['eu-west-1']);
  });

  it('refuses a value holding a template directive', () => {
    expect(tf('provider "aws" {\n  region = "%{if true}eu-west-1%{endif}"\n}')).toEqual([]);
  });

  it('reads a CRLF file with a heredoc', () => {
    const text =
      'provider "aws" {\r\n  profile = <<EOF\r\nregion = "us-east-1"\r\nEOF\r\n  region = "eu-west-1"\r\n}\r\n';
    expect(regions(tf(text))).toEqual(['eu-west-1']);
  });
});

describe('fly.toml: primary_region is a top-level key', () => {
  it('does not read one inside a multi-line basic string', () => {
    const text = 'primary_region = "fra"\n[processes]\n  app = """\nprimary_region = "syd"\n"""\n';
    expect(regions(fly(text))).toEqual(['fra']);
  });

  it('does not read one inside a multi-line literal string at the top level', () => {
    const text = "release_command = '''\nprimary_region = \"sin\"\n'''\nprimary_region = \"fra\"\n";
    expect(regions(fly(text))).toEqual(['fra']);
  });

  it('does not read one under a table', () => {
    expect(regions(fly('primary_region = "fra"\n[env]\n  primary_region = "iad"\n'))).toEqual([
      'fra',
    ]);
  });

  it('does not read a dotted key or an inline table', () => {
    expect(fly('env.primary_region = "iad"\n')).toEqual([]);
    expect(fly('env = { primary_region = "iad" }\n')).toEqual([]);
  });

  it('reads a literal string', () => {
    expect(regions(fly("primary_region = 'fra'\n"))).toEqual(['fra']);
  });

  it('reads a CRLF file with a multi-line string', () => {
    const text =
      'primary_region = "fra"\r\n[processes]\r\n  app = """\r\nprimary_region = "syd"\r\n"""\r\n';
    expect(regions(fly(text))).toEqual(['fra']);
  });

  it('closes a multi-line string on a run of more than three quotes', () => {
    expect(regions(fly('note = """say ""hi"""""\nprimary_region = "fra"\n'))).toEqual(['fra']);
  });
});

describe('limitations: each hides a region, and lifting one is deliberate', () => {
  // docs/LIMITATIONS.md. A case here starting to return a region is a test
  // failure to act on, not a win.
  it('stops at a nested array line opening with [ before primary_region', () => {
    expect(fly('matrix = [\n  [1, 2],\n]\nprimary_region = "fra"\n')).toEqual([]);
  });

  it('hides the rest of the file after an unterminated heredoc', () => {
    expect(tf('provider "aws" {\n  profile = <<EOF\n  region = "eu-west-1"\n}\n')).toEqual([]);
  });
});
