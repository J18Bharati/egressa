#!/usr/bin/env bash
#
# What is actually running, as against what the repository declares.
#
# `egressa scan` reads a repository and is offline by design. This reads an AWS
# account and is therefore the one thing in this project that reaches the
# network during an ordinary run -- so it is opt-in, read-only, and never
# invoked by a scan.
#
# It emits gates, not findings: `KEY: value` lines naming the regions observed.
# Resolving a region to a country is the knowledge base's job, and this script
# deliberately says nothing about jurisdiction, adequacy or anyone's position.
#
#   EGRESSA_ALLOW_AWS=1 bash reconcile-aws.sh
#
# Exit codes
#   0  ran, output is complete
#   3  the AWS CLI is not available -- nothing ran
#   4  not opted in
#   5  credentials did not resolve -- nothing ran
set -uo pipefail

echo "AWS_PROTO: 1"

if [ "${EGRESSA_ALLOW_AWS:-0}" != "1" ]; then
  echo "DEGRADED: not opted in; set EGRESSA_ALLOW_AWS=1 to allow read-only AWS calls" >&2
  echo "DEGRADED: nothing ran, so there is nothing to compare the repository against" >&2
  exit 4
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "DEGRADED: the aws CLI is not on PATH" >&2
  echo "DEGRADED: the reconciliation DID NOT RUN -- do not report agreement or drift" >&2
  exit 3
fi

echo "AWS_CLI: present"
echo "AWS_CLI_VERSION: $(aws --version 2>&1 | head -1)"

# Identity first. Everything below is meaningless without knowing whose account
# was read, and a failure here is a stop rather than an empty result.
identity=$(aws sts get-caller-identity --output text --query 'Account' 2>/dev/null)
if [ -z "$identity" ]; then
  echo "DEGRADED: credentials did not resolve; no account was read" >&2
  echo "DEGRADED: the reconciliation DID NOT RUN -- do not report agreement or drift" >&2
  exit 5
fi
echo "AWS_ACCOUNT: $identity"
echo "AWS_CONFIGURED_REGION: $(aws configure get region 2>/dev/null || echo none)"

# Enabled regions. An account can only hold resources in a region it has
# enabled, so this bounds everything that follows.
enabled=$(aws ec2 describe-regions --query 'Regions[].RegionName' --output text 2>/dev/null)
if [ -n "$enabled" ]; then
  echo "AWS_ENABLED_REGIONS: $(echo "$enabled" | tr '\t' ' ')"
else
  echo "DEGRADED: could not list enabled regions; the sweep below may be incomplete" >&2
fi

# S3 first, because a bucket is the most common place for personal data to sit
# and its location is one cheap call.
buckets=$(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null)
if [ -n "$buckets" ]; then
  for bucket in $buckets; do
    loc=$(aws s3api get-bucket-location --bucket "$bucket" --output text 2>/dev/null)
    # The API returns None for us-east-1, which is a quirk of the call rather
    # than an absent region.
    [ "$loc" = "None" ] && loc="us-east-1"
    [ -n "$loc" ] && echo "AWS_RESOURCE_REGION: s3 $bucket $loc"
  done
else
  echo "AWS_S3: none listed"
fi

# A tagged-resource sweep per enabled region. One read-only call each, capped,
# because the question is which regions are in use rather than what is in them.
for region in $enabled; do
  found=$(aws resourcegroupstaggingapi get-resources \
    --region "$region" --max-items 1 \
    --query 'ResourceTagMappingList[0].ResourceARN' --output text 2>/dev/null)
  if [ -n "$found" ] && [ "$found" != "None" ]; then
    echo "AWS_REGION_IN_USE: $region"
  fi
done

echo "AWS_END: ok"
