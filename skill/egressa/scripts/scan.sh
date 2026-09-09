#!/usr/bin/env bash
# Thin wrapper: runs the scanner and emits JSON on stdout.
# Usage: scan.sh [path] [extra adequacy flags...]
set -euo pipefail

target="${1:-.}"
shift || true

npx -y egressa@latest scan "$target" --format json "$@"
