#!/usr/bin/env bash
# Run the transfer scan and emit JSON on stdout.
#
# Resolution order, first hit wins:
#   1. the Egressa build in the checkout this skill lives in, when it lives in one
#   2. bin/lib/egressa.mjs bundled beside this script
#   3. an `egressa` already on PATH
#   4. npx, which needs the package published and a network -- opt in with
#      EGRESSA_ALLOW_NPX=1, since a skill should not reach the network silently
#
# Every candidate is resolved from this script's own location, never from the
# scan target. The target is the repository under review, which is untrusted
# input: this used to walk up from it and run the first packages/cli/dist/cli.js
# it found, so a repository that committed one had it executed by `node` with
# the reviewer's credentials during a review that reads as read-only.
#
# The checkout build comes before the bundle because the bundle usually runs
# without the native parser and reports `engine.degraded: true` (manifest
# signals only), while a checkout build resolves oxc-parser and does full
# call-site analysis. Egressa reviewing itself therefore loses nothing.
#
# Exits 3 with a message on stderr when none resolve. The caller must report
# that transfer detection did not run, rather than reporting a clean result.
set -uo pipefail

target="${1:-.}"
requested="$target"
shift || true

SELF="$(cd "$(dirname "$0")/.." && pwd -P)"

# Leave the target before anything runs. The working directory is usually the
# repository under review, and npm reads a project `.npmrc` from it -- a
# `registry=` line there would point the npx branch at an attacker's registry.
# A relative PATH entry (`.`, `node_modules/.bin`) resolves against it too, and
# could shadow `egressa` or the `node` every branch below runs.
if ! target="$(cd "$target" 2>/dev/null && pwd -P)"; then
  echo "scan-transfers: scan target is not a readable directory: $requested" >&2
  exit 2
fi
cd "$SELF" || exit 3
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep '^/' | paste -sd: -)"

# The checkout this skill lives in, if it lives in one -- never the target.
if [ -f "$SELF/../../../packages/cli/dist/cli.js" ]; then
  exec node "$SELF/../../../packages/cli/dist/cli.js" scan "$target" --format json "$@"
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

echo "scan-transfers: no egressa binary found (checkout build, bundle, PATH, or npx)." >&2
echo "scan-transfers: transfer detection DID NOT RUN — do not report a clean result." >&2
exit 3
