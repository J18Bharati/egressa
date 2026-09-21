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
#
# Generated output is excluded for a sharper reason than noise. A framework's build
# directory carries the vendors it *could* wire up, not the ones this project did:
# `.nuxt/imports.d.ts` declares a composable for every third-party script the module
# supports, so a repository that uses none of them still contains the string `hotjar`.
# A gate reading that is not detecting a tracker, it is reading a catalogue -- and on
# the consent half of the conjunction below, a false positive suppresses a real signal
# rather than raising a false one, which is the harder failure to notice.
SRC="$(printf '%s\n' "${FILES:-}" \
  | grep -Ev '(^|/)node_modules/|(^|/)dist/|(^|/)build/|(^|/)\.next/|(^|/)coverage/|(^|/)\.nuxt/|(^|/)\.output/|(^|/)\.svelte-kit/|(^|/)\.astro/|(^|/)\.vercel/|(^|/)\.turbo/|(^|/)\.amplify-hosting/|\.min\.js$|\.map$' \
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

# ---------------------------------------------------------------- gate helpers
#
# Every gate captures its pipeline's output and tests that, rather than ending in
# `grep -q`. `grep -q` exits at its first match and closes the pipe under the
# `printf` still writing the file list; the writer then takes SIGPIPE, exits 141,
# and `pipefail` promotes 141 to the status of the whole pipeline. The gate read
# `false` on any repository whose file list was larger than a pipe buffer -- 64 KiB
# on Linux -- while the script still printed a well-formed block, so the review
# reported nothing to look at and said nothing about why. Running the pipeline to
# completion removes the early exit, and therefore the signal.
#
# Capture-then-test, not `grep -q pat <(cmd)`: process substitution also avoids
# SIGPIPE but throws away the producer's status, and the status is what makes an
# unhealthy gate distinguishable from an empty one below.
#
# Status convention for every helper here:
#   0  matched
#   1  did not match  (an ordinary, healthy empty result)
#   >1 the gate could not be evaluated
#
# Distinguishing 1 from >1 takes care. `grep` returns 1 for "no match" and 2 for a
# genuine failure, but `xargs` flattens both into 123, so the status of an `xargs`
# run says nothing on its own. The wrapper below therefore maps grep's own status
# inside each batch: 0 and 1 become 0, anything worse becomes 255, which is the one
# value `xargs` reports distinctly (as 124).
#
# GATE_OUT / GATE_STATUS are the last helper's result; `gate` reads them.

# Runs grep over the reviewed CODE set. $1 is the pattern.
hits() {
  [ -z "$CODE" ] && return 1
  GATE_OUT="$(printf '%s\n' "$CODE" | tr '\n' '\0' \
    | xargs -0 -r sh -c 'grep -lIE "$0" "$@" 2>/dev/null; s=$?; [ "$s" -le 1 ] && exit 0; exit 255' "$1" 2>/dev/null)"
  GATE_STATUS=$?
  [ -n "$GATE_OUT" ] && return 0
  [ "$GATE_STATUS" -eq 0 ] && return 1
  return "$GATE_STATUS"
}

paths() {
  [ -z "$EXISTING" ] && return 1
  GATE_OUT="$(printf '%s\n' "$EXISTING" | grep -E "$1")"
  GATE_STATUS=$?
  [ -n "$GATE_OUT" ] && return 0
  [ "$GATE_STATUS" -le 1 ] && return 1
  return "$GATE_STATUS"
}

# Dependency manifests are read whole regardless of mode: a tracker dependency added
# three commits ago is still in the product being reviewed.
declared() {
  GATE_OUT="$(grep -rIlE "$1" --include=package.json . 2>/dev/null \
    | grep -v node_modules \
    | { [ -n "${SELF_REL:-}" ] && grep -v "^\./${SELF_REL}/" || cat; })"
  GATE_STATUS=$?
  [ -n "$GATE_OUT" ] && return 0
  [ "$GATE_STATUS" -le 1 ] && return 1
  return "$GATE_STATUS"
}

# ---------------------------------------------------------------- comment stripping
#
# Used only by the tracker conjunction. A commented-out `gtag(` placeholder is not a
# tracker, and SIGNAL_TRACKERS_NO_CONSENT is the one line here that asserts something
# rather than routing work to a specialist -- so it is the one line that must not fire
# on dead code. Every other gate keeps matching raw text, because a needless route is
# cheap and a missed one is not.
#
# The prefix is chosen by extension, over the same 26 the CODE filter admits. Each
# pattern is anchored to the start of the line: an unanchored `//` strip removes any
# line containing `https://`, which quietly deletes live call sites from the corpus.

# The extensions belonging to one comment family. Together these partition the 26
# the CODE filter admits, so no reviewed file is left unstripped by accident.
_comment_exts() {
  case "$1" in
    hash) echo '\.(py|rb|erb)$' ;;
    markup) echo '\.(html|htm|ejs|hbs|handlebars|vue|svelte|astro)$' ;;
    pug) echo '\.pug$' ;;
    *) echo '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|php|go|java|kt|cs|swift)$' ;;
  esac
}

# sed program that deletes comment lines for one family.
_comment_sed() {
  _cs_markup='/^[[:space:]]*<!--.*-->[[:space:]]*$/d;/^[[:space:]]*<!--/,/-->/d;/^[[:space:]]*\{\{!/d'
  _cs_slash='/^[[:space:]]*\/\//d;/^[[:space:]]*\/\*.*\*\//d;/^[[:space:]]*\/\*/,/\*\//d'
  case "$1" in
    hash) echo '/^[[:space:]]*#/d;/^[[:space:]]*<%#/d' ;;
    # Markup carries both syntaxes. An HTML file is the single most likely place to
    # find a tracker snippet commented out inside a `<script>` block -- which is a
    # `//` comment in a `.html` file -- so stripping only `<!-- -->` here leaves the
    # exact case this signal exists to not fire on.
    markup) echo "$_cs_markup;$_cs_slash" ;;
    pug) echo '/^[[:space:]]*\/\//d' ;;
    *) echo "$_cs_slash" ;;
  esac
}

# Like hits(), with comment lines removed first. Only a boolean is wanted, so the
# files of one family are stripped and searched as a single stream.
hits_live() {
  [ -z "$CODE" ] && return 1
  _hl_worst=1
  for _hl_fam in hash markup pug slash; do
    _hl_files="$(printf '%s\n' "$CODE" | grep -E "$(_comment_exts "$_hl_fam")")"
    [ -z "$_hl_files" ] && continue
    GATE_OUT="$(printf '%s\n' "$_hl_files" | tr '\n' '\0' \
      | xargs -0 -r sed -E "$(_comment_sed "$_hl_fam")" 2>/dev/null \
      | grep -aE "$1")"
    GATE_STATUS=$?
    [ -n "$GATE_OUT" ] && return 0
    [ "$GATE_STATUS" -gt 1 ] && _hl_worst="$GATE_STATUS"
  done
  GATE_STATUS="$_hl_worst"
  return "$_hl_worst"
}

# ---------------------------------------------------------------- gate reporting
#
# A gate that could not be evaluated still prints its normal `false` line -- the
# orchestrator's parser does not change shape -- and prints one extra line naming
# the gate and the status. Without it, no-match and broken read identically, which
# is how the SIGPIPE above stayed invisible for as long as it did.
probe() {
  _p_name="$1"
  shift
  "$@"
  _p_status=$?
  PROBE_STATUS="$_p_status"
  if [ "$_p_status" -eq 0 ]; then
    PROBE=true
  else
    PROBE=false
    [ "$_p_status" -ne 1 ] && printf 'SCOPE_DEGRADED: %s exit=%s\n' "$_p_name" "$_p_status"
  fi
  return 0
}

# gate NAME helper pattern -- emits `NAME: true|false`.
gate() {
  probe "$@"
  emit "$1" "$PROBE"
}

# ---------------------------------------------------------------- scope signals
gate SCOPE_FRONTEND      paths '\.(tsx|jsx|svelte|vue)$|(^|/)(app|pages|src/components)/'
gate SCOPE_BACKEND       paths '(^|/)(api|server|routes|controllers|handlers|lambda|functions)/|\.(server|route|controller)\.(ts|js|mts|cts)$'
gate SCOPE_SCHEMA        paths 'schema\.prisma$|(^|/)migrations?/|(^|/)drizzle/|\.sql$|(^|/)models?/|entity\.(ts|js)$'
gate SCOPE_IAC           paths '\.tf$|(^|/)cdk/|cdk\.json$|serverless\.ya?ml$|template\.ya?ml$|docker-compose\.ya?ml$'

gate SCOPE_TRACKERS      declared 'posthog|mixpanel|amplitude|@segment/|analytics-node|react-ga|gtag|logrocket|fullstory|@microsoft/clarity|hotjar|smartlook|heap-api|react-facebook-pixel|@snapchat|tiktok-pixel'
gate SCOPE_TRACKER_CODE  hits 'gtag\(|dataLayer|fbq\(|_linkedin_partner_id|ttq\.|snaptr\(|clarity\(|hj\(|posthog\.init|mixpanel\.init|amplitude\.(init|getInstance)|analytics\.load|LogRocket\.init|FS\.identify|Smartlook'
gate SCOPE_SESSION_REPLAY hits 'logrocket|fullstory|@microsoft/clarity|hotjar|smartlook|session_?[Rr]ecording|record[Cc]anvas|maskAllInputs'

gate SCOPE_CONSENT       hits '__tcfapi|__cmp\(|onetrust|OneTrust|Cookiebot|klaro|osano|cookieconsent|CookieConsent|consent[_-]?[Mm]ode|hasConsent|consentGranted|analytics_storage|ad_storage'
gate SCOPE_CLIENT_STORAGE hits 'document\.cookie|localStorage\.|sessionStorage\.|indexedDB|res\.cookie\(|[Ss]et-[Cc]ookie|cookies\(\)\.set|serializeCookie'

gate SCOPE_LOGGING       hits '\b(pino|winston|bunyan|log4js|loglevel)\b|console\.(log|info|warn|error|debug)\(|@sentry/|Sentry\.(init|captureException)|datadog|@opentelemetry'
gate SCOPE_CACHE         hits '\b(ioredis|redis|memcached|memjs)\b|createClient\(|\.setex\(|\.expire\('
gate SCOPE_OPT_OUT       hits 'globalPrivacyControl|Sec-GPC|sec-gpc|[Dd]o[_-]?[Nn]ot[_-]?[Tt]rack|navigator\.doNotTrack|opt[_-]?[Oo]ut'
gate SCOPE_ERASURE       hits 'delete[A-Z][A-Za-z]*\(|deleteMany|destroy\(|softDelete|deletedAt|deleted_at|anonymi[sz]e|purge|GDPR|dsar|[Dd]ata[_-]?[Ss]ubject'

# ---------------------------------------------------------------- conjunction
# The one signal worth computing here rather than in a specialist: a product that
# ships trackers and contains no consent machinery anywhere. Cheap, repo-wide, and
# the least arguable thing this tool can say.
#
# These three alone read code with its comment lines removed. A repository whose
# only `gtag(` is a commented-out placeholder has no tracker, and raising this
# line on it would be an accusation about dead code. package.json carries no
# comments, so the manifest side needs no stripping.
probe SIGNAL_TRACKERS_NO_CONSENT declared 'posthog|mixpanel|amplitude|@segment/|analytics-node|react-ga|logrocket|fullstory|@microsoft/clarity|hotjar|smartlook|heap-api|react-facebook-pixel'
T="$PROBE"
probe SIGNAL_TRACKERS_NO_CONSENT hits_live 'gtag\(|dataLayer|fbq\(|_linkedin_partner_id|ttq\.|snaptr\(|posthog\.init|mixpanel\.init|analytics\.load'
TC="$PROBE"
probe SIGNAL_TRACKERS_NO_CONSENT hits_live '__tcfapi|onetrust|OneTrust|Cookiebot|klaro|osano|cookieconsent|consent[_-]?[Mm]ode|hasConsent|consentGranted|analytics_storage'
C="$PROBE"
C_STATUS="$PROBE_STATUS"

# A consent gate that could not be evaluated reads `false`, and "no consent found"
# is exactly the half of this conjunction that carries the accusation. Absence of
# evidence from a gate that did not run is not absence of consent machinery, so the
# signal stays down and the SCOPE_DEGRADED line above says why.
[ "$C_STATUS" -gt 1 ] && C="unknown"

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
