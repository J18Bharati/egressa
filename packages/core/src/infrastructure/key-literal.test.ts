import { describe, expect, it } from 'vitest';
import { regionsFromKeyLiterals } from './key-literal.js';

const tf = (text: string, provider = 'aws') =>
  regionsFromKeyLiterals(text, 'main.tf', ['region'], provider, 'provider');
const fly = (text: string) => regionsFromKeyLiterals(text, 'fly.toml', ['primary_region'], 'fly');

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
