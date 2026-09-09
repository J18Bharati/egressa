#!/usr/bin/env bash
# Runs the scanner and emits JSON on stdout.
# Usage: scan.sh [path] [extra egressa flags...]
#
# Resolution order, first hit wins:
#   1. a build in the repository being scanned
#   2. the copy bundled with the privacy-review skill, if both are installed
#   3. an `egressa` already on PATH
#   4. npx, only when EGRESSA_ALLOW_NPX=1 -- nothing is published yet, and a
#      skill should not reach the network on its own regardless
#
# Exits 3 when none resolve. Report that the scan did not run; never report a
# clean result on the strength of a missing binary.
set -uo pipefail

target="${1:-.}"
shift || true

SELF="$(cd "$(dirname "$0")/.." && pwd -P)"

d="$(cd "$target" 2>/dev/null && pwd -P || pwd -P)"
while [ "$d" != "/" ]; do
  if [ -f "$d/packages/cli/dist/cli.js" ]; then
    exec node "$d/packages/cli/dist/cli.js" scan "$target" --format json "$@"
  fi
  d="$(dirname "$d")"
done

if [ -f "$SELF/../../packages/cli/dist/cli.js" ]; then
  exec node "$SELF/../../packages/cli/dist/cli.js" scan "$target" --format json "$@"
fi

# Sibling skill in the same plugin ships a prebuilt copy.
if [ -f "$SELF/../privacy-review/bin/lib/egressa.mjs" ]; then
  exec node "$SELF/../privacy-review/bin/lib/egressa.mjs" scan "$target" --format json "$@"
fi

if command -v egressa >/dev/null 2>&1; then
  exec egressa scan "$target" --format json "$@"
fi

if command -v npx >/dev/null 2>&1 && [ "${EGRESSA_ALLOW_NPX:-0}" = "1" ]; then
  exec npx -y egressa@latest scan "$target" --format json "$@"
fi

echo "scan.sh: no egressa binary found (repo build, bundled copy, PATH, or npx)." >&2
echo "scan.sh: the scan DID NOT RUN — do not report a clean result." >&2
exit 3
