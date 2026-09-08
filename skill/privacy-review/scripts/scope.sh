#!/usr/bin/env bash
# Scope detection for the privacy review. Emits `KEY: value` lines on stdout.
#
# Usage:
#   scope.sh                 # review the working tree against the default base branch
#   scope.sh --base main     # review the diff against an explicit base
#   scope.sh --repo          # review the whole repository, ignoring git history
#
# Every signal is a gate, not a finding. The orchestrator decides which specialists
# to dispatch from these lines; the specialists decide what is actually wrong.
# One conjunction is special and is emitted as its own line: SIGNAL_TRACKERS_NO_CONSENT.
set -uo pipefail

MODE="diff"
BASE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) MODE="repo"; shift ;;
    --base) BASE="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

emit() { printf '%s: %s\n' "$1" "$2"; }

echo "SCOPE_PROTO: 1"
emit MODE "$MODE"

# ---------------------------------------------------------------- file set
# FILES is the newline-separated list of source files under review.
if [ "$MODE" = "diff" ]; then
  if [ -z "$BASE" ]; then
    for cand in main master develop; do
      if git rev-parse --verify --quiet "refs/heads/$cand" >/dev/null 2>&1; then BASE="$cand"; break; fi
    done
  fi
  if [ -z "$BASE" ]; then
    emit MODE repo
    emit DEGRADED "no base branch found; falling back to whole-repo mode"
    MODE="repo"
  else
    emit BASE "$BASE"
    DIFF_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null || echo "")"
    if [ -z "$DIFF_BASE" ]; then
      emit DEGRADED "no merge-base with $BASE; falling back to whole-repo mode"
      MODE="repo"
    else
      emit DIFF_BASE "$DIFF_BASE"
      FILES="$(git diff --name-only --diff-filter=d "$DIFF_BASE" HEAD 2>/dev/null; git diff --name-only --diff-filter=d 2>/dev/null)"
      FILES="$(printf '%s\n' "$FILES" | sort -u | sed '/^$/d')"
      STAT="$(git diff --shortstat "$DIFF_BASE" 2>/dev/null || echo "")"
      INS="$(printf '%s' "$STAT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)"
      DEL="$(printf '%s' "$STAT" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)"
      emit DIFF_LINES "$(( INS + DEL ))"
    fi
  fi
fi

if [ "$MODE" = "repo" ]; then
  FILES="$(git ls-files 2>/dev/null || find . -type f -not -path './.git/*' | sed 's|^\./||')"
  emit DIFF_LINES "n/a"
fi

# Source files we can reason about. node_modules is never read -- same rule as the engine.
SRC="$(printf '%s\n' "${FILES:-}" \
  | grep -Ev '(^|/)node_modules/|(^|/)dist/|(^|/)build/|(^|/)\.next/|(^|/)coverage/|\.min\.js$|\.map$' \
  | sed '/^$/d')"
emit FILES_UNDER_REVIEW "$(printf '%s\n' "$SRC" | sed '/^$/d' | wc -l | tr -d ' ')"

# Existing files only -- a deleted path cannot be grepped.
EXISTING="$(printf '%s\n' "$SRC" | while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && printf '%s\n' "$f"; done)"

# Exclude this skill's own tree from its own review.
#
# Without this the review reports on itself: every pattern the checklists document
# and every pattern this script greps for is a literal string inside a file the
# scan would otherwise read, so a repository that merely *contains* the reviewer
# trips every gate. Same failure as a secret scanner flagging its own fixtures.
SELF_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P || true)"
REPO_ROOT="$(pwd -P)"
case "$SELF_DIR" in
  "$REPO_ROOT"/*)
    SELF_REL="${SELF_DIR#"$REPO_ROOT"/}"
    EXISTING="$(printf '%s\n' "$EXISTING" | grep -v "^${SELF_REL}/" || true)"
    emit SELF_EXCLUDED "$SELF_REL"
    ;;
esac

# Code files only, for the content gates.
#
# Prose is not behaviour. Documentation, a changelog or a knowledge base entry that
# names a tracker is not a tracker, and grepping every text file makes a repository
# that writes *about* privacy look identical to one with a privacy problem. Path-shape
# gates below stay over the full set, because a path is not a claim about content.
CODE="$(printf '%s\n' "$EXISTING" | grep -EI '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro|html|htm|ejs|hbs|handlebars|pug|php|py|rb|go|java|kt|cs|swift|erb)$' || true)"
emit CODE_FILES "$(printf '%s\n' "$CODE" | sed '/^$/d' | wc -l | tr -d ' ')"

# grep helper: search the reviewed CODE set for a pattern, print nothing, return status.
hits() {
  [ -z "$CODE" ] && return 1
  printf '%s\n' "$CODE" | tr '\n' '\0' | xargs -0 -r grep -lIE "$1" 2>/dev/null | grep -q .
}
paths() {
  [ -z "$EXISTING" ] && return 1
  printf '%s\n' "$EXISTING" | grep -qE "$1"
}
# Dependency manifests are read whole regardless of mode: a tracker dependency added
# three commits ago is still in the product being reviewed.
declared() {
  grep -rIlE "$1" --include=package.json . 2>/dev/null \
    | grep -v node_modules \
    | { [ -n "${SELF_REL:-}" ] && grep -v "^\./${SELF_REL}/" || cat; } \
    | grep -q .
}

flag() { if "$@"; then echo true; else echo false; fi; }

# ---------------------------------------------------------------- scope signals
emit SCOPE_FRONTEND      "$(flag paths '\.(tsx|jsx|svelte|vue)$|(^|/)(app|pages|src/components)/')"
emit SCOPE_BACKEND       "$(flag paths '(^|/)(api|server|routes|controllers|handlers|lambda|functions)/|\.(server|route|controller)\.(ts|js|mts|cts)$')"
emit SCOPE_SCHEMA        "$(flag paths 'schema\.prisma$|(^|/)migrations?/|(^|/)drizzle/|\.sql$|(^|/)models?/|entity\.(ts|js)$')"
emit SCOPE_IAC           "$(flag paths '\.tf$|(^|/)cdk/|cdk\.json$|serverless\.ya?ml$|template\.ya?ml$|docker-compose\.ya?ml$')"

emit SCOPE_TRACKERS      "$(flag declared 'posthog|mixpanel|amplitude|@segment/|analytics-node|react-ga|gtag|logrocket|fullstory|@microsoft/clarity|hotjar|smartlook|heap-api|react-facebook-pixel|@snapchat|tiktok-pixel')"
emit SCOPE_TRACKER_CODE  "$(flag hits 'gtag\(|dataLayer|fbq\(|_linkedin_partner_id|ttq\.|snaptr\(|clarity\(|hj\(|posthog\.init|mixpanel\.init|amplitude\.(init|getInstance)|analytics\.load|LogRocket\.init|FS\.identify|Smartlook')"
emit SCOPE_SESSION_REPLAY "$(flag hits 'logrocket|fullstory|@microsoft/clarity|hotjar|smartlook|session_?[Rr]ecording|record[Cc]anvas|maskAllInputs')"

emit SCOPE_CONSENT       "$(flag hits '__tcfapi|__cmp\(|onetrust|OneTrust|Cookiebot|klaro|osano|cookieconsent|CookieConsent|consent[_-]?[Mm]ode|hasConsent|consentGranted|analytics_storage|ad_storage')"
emit SCOPE_CLIENT_STORAGE "$(flag hits 'document\.cookie|localStorage\.|sessionStorage\.|indexedDB|res\.cookie\(|[Ss]et-[Cc]ookie|cookies\(\)\.set|serializeCookie')"

emit SCOPE_LOGGING       "$(flag hits '\b(pino|winston|bunyan|log4js|loglevel)\b|console\.(log|info|warn|error|debug)\(|@sentry/|Sentry\.(init|captureException)|datadog|@opentelemetry')"
emit SCOPE_CACHE         "$(flag hits '\b(ioredis|redis|memcached|memjs)\b|createClient\(|\.setex\(|\.expire\(')"
emit SCOPE_OPT_OUT       "$(flag hits 'globalPrivacyControl|Sec-GPC|sec-gpc|[Dd]o[_-]?[Nn]ot[_-]?[Tt]rack|navigator\.doNotTrack|opt[_-]?[Oo]ut')"
emit SCOPE_ERASURE       "$(flag hits 'delete[A-Z][A-Za-z]*\(|deleteMany|destroy\(|softDelete|deletedAt|deleted_at|anonymi[sz]e|purge|GDPR|dsar|[Dd]ata[_-]?[Ss]ubject')"

# ---------------------------------------------------------------- conjunction
# The one signal worth computing here rather than in a specialist: a product that
# ships trackers and contains no consent machinery anywhere. Cheap, repo-wide, and
# the least arguable thing this tool can say.
T="$(flag declared 'posthog|mixpanel|amplitude|@segment/|analytics-node|react-ga|logrocket|fullstory|@microsoft/clarity|hotjar|smartlook|heap-api|react-facebook-pixel')"
TC="$(flag hits 'gtag\(|dataLayer|fbq\(|_linkedin_partner_id|ttq\.|snaptr\(|posthog\.init|mixpanel\.init|analytics\.load')"
C="$(flag hits '__tcfapi|onetrust|OneTrust|Cookiebot|klaro|osano|cookieconsent|consent[_-]?[Mm]ode|hasConsent|consentGranted|analytics_storage')"
if { [ "$T" = "true" ] || [ "$TC" = "true" ]; } && [ "$C" = "false" ]; then
  emit SIGNAL_TRACKERS_NO_CONSENT true
else
  emit SIGNAL_TRACKERS_NO_CONSENT false
fi

# ---------------------------------------------------------------- stack context
STACK=""
[ -f package.json ] && STACK="${STACK}node "
{ [ -f tsconfig.json ] || paths '\.tsx?$'; } && STACK="${STACK}typescript "
grep -qE '"next"' package.json 2>/dev/null && STACK="${STACK}next "
[ -f schema.prisma ] || paths 'schema\.prisma$' && STACK="${STACK}prisma "
[ -f requirements.txt ] || [ -f pyproject.toml ] && STACK="${STACK}python "
[ -f go.mod ] && STACK="${STACK}go "
emit STACK "${STACK:-unknown}"

TEST_FW="unknown"
[ -f vitest.config.ts ] || [ -f vitest.config.js ] && TEST_FW="vitest"
{ [ -f jest.config.ts ] || [ -f jest.config.js ]; } && TEST_FW="jest"
{ [ -f pytest.ini ] || [ -f conftest.py ]; } && TEST_FW="pytest"
emit TEST_FW "$TEST_FW"

echo "SCOPE_END: ok"
