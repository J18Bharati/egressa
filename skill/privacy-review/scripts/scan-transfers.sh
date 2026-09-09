#!/usr/bin/env bash
# Run the transfer scan and emit JSON on stdout.
#
# Resolution order, first hit wins:
#   1. a build in the surrounding repo (packages/cli/dist/cli.js)
#   2. bin/lib/egressa.mjs bundled beside this script
#   3. an `egressa` already on PATH
#   4. npx, which needs the package published and a network -- opt in with
#      EGRESSA_ALLOW_NPX=1, since a skill should not reach the network silently
#
# The repo build comes FIRST even though the bundle is more self-contained,
# because the bundle usually runs without the native parser and reports
# `engine.degraded: true` (manifest signals only). A repo build resolves
# oxc-parser from packages/cli/node_modules and does full call-site analysis, so
# where both exist the repo build strictly dominates. The bundle is what makes
# the skill work at all in someone else's project.
#
# Exits 3 with a message on stderr when none resolve. The caller must report
# that transfer detection did not run, rather than reporting a clean result.
set -uo pipefail

target="${1:-.}"
shift || true

SELF="$(cd "$(dirname "$0")/.." && pwd -P)"

# Walk up from the scan target looking for a repo build.
d="$(cd "$target" 2>/dev/null && pwd -P || pwd -P)"
while [ "$d" != "/" ]; do
  if [ -f "$d/packages/cli/dist/cli.js" ]; then
    exec node "$d/packages/cli/dist/cli.js" scan "$target" --format json "$@"
  fi
  d="$(dirname "$d")"
done

# Also try the repo this skill lives in, which is not necessarily the target.
if [ -f "$SELF/../../packages/cli/dist/cli.js" ]; then
  exec node "$SELF/../../packages/cli/dist/cli.js" scan "$target" --format json "$@"
fi

if [ -f "$SELF/bin/lib/egressa.mjs" ]; then
  exec node "$SELF/bin/lib/egressa.mjs" scan "$target" --format json "$@"
fi

if command -v egressa >/dev/null 2>&1; then
  exec egressa scan "$target" --format json "$@"
fi

if command -v npx >/dev/null 2>&1 && [ "${EGRESSA_ALLOW_NPX:-0}" = "1" ]; then
  exec npx -y egressa@latest scan "$target" --format json "$@"
fi

echo "scan-transfers: no egressa binary found (bundle, repo build, PATH, or npx)." >&2
echo "scan-transfers: transfer detection DID NOT RUN — do not report a clean result." >&2
exit 3
