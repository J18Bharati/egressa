#!/usr/bin/env bash
# Scope detection for the privacy review. Emits `KEY: value` lines on stdout.
#
# Usage:
#   scope.sh                 # review the working tree against the default base branch
#   scope.sh --base main     # review the diff against an explicit base
#   scope.sh --repo          # review the whole repository, ignoring git history
#   scope.sh ... --list      # print only the reviewed file set, one path per line,
#                            # for specialists -- never have them run git themselves
#
# Every signal is a gate, not a finding. The orchestrator decides which specialists
# to dispatch from these lines; the specialists decide what is actually wrong.
# One conjunction is special and is emitted as its own line: SIGNAL_TRACKERS_NO_CONSENT.
set -uo pipefail

MODE="diff"
BASE=""
LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) MODE="repo"; shift ;;
    --list) LIST=1; shift ;;
    # `shift; shift` rather than `shift 2`: with `--base` as the last argument
    # there is nothing to shift twice, and bash's `shift 2` then shifts nothing
    # at all rather than failing. With no `set -e` the loop never advances and
    # the script spins forever, printing not one line -- so an orchestrator
    # substituting an empty branch name wedges the review before it starts,
    # which is worse than any gate this file was rewritten to fix.
    --base) BASE="${2:-}"; shift; shift ;;
    *) shift ;;
  esac
done

emit() { [ "$LIST" = 1 ] || printf '%s: %s\n' "$1" "$2"; }

# git, run inside the repository under review, with that repository's own
# configuration unable to execute anything. A repository handed over with its
# .git directory -- an archive, a shared folder; a clone cannot carry it --
# brings its own .git/config, and git runs core.fsmonitor on every index
# refresh: `git ls-files` and every worktree `git diff` below. The other keys
# close the same door for an external diff, a pager and hooks. Every git call
# in this script goes through here.
git_safe() {
  git -c core.fsmonitor= -c core.hooksPath=/dev/null -c core.pager=cat -c diff.external= "$@"
}

# Filter drivers. `.git/info/attributes` or `.gitattributes` can assign a clean,
# smudge or process filter that the repository's config defines, and git runs
# it to hash every stat-dirty worktree file -- which every file is after an
# archive is extracted. Every driver git can see is blanked and marked not
# required, through GIT_CONFIG_COUNT rather than `-c`, because `-c` splits at
# the first `=` and a driver name may contain one. `git config` itself runs
# nothing.
_n=0
while IFS= read -r -d '' _key; do
  export "GIT_CONFIG_KEY_$_n=$_key" "GIT_CONFIG_VALUE_$_n="
  _n=$((_n + 1))
  export "GIT_CONFIG_KEY_$_n=${_key%.*}.required" "GIT_CONFIG_VALUE_$_n=false"
  _n=$((_n + 1))
done < <(git_safe config -z --name-only --get-regexp '^filter\..*\.(clean|smudge|process)$' 2>/dev/null)
export GIT_CONFIG_COUNT="$_n"

emit SCOPE_PROTO 1
emit MODE "$MODE"

# ---------------------------------------------------------------- file set
# FILES is the newline-separated list of source files under review.
if [ "$MODE" = "diff" ]; then
  if [ -z "$BASE" ]; then
    for cand in main master develop; do
      if git_safe rev-parse --verify --quiet "refs/heads/$cand" >/dev/null 2>&1; then BASE="$cand"; break; fi
    done
  fi
  if [ -z "$BASE" ]; then
    emit MODE repo
    emit DEGRADED "no base branch found; falling back to whole-repo mode"
    MODE="repo"
  else
    emit BASE "$BASE"
    DIFF_BASE="$(git_safe merge-base "$BASE" HEAD 2>/dev/null || echo "")"
    if [ -z "$DIFF_BASE" ]; then
      emit DEGRADED "no merge-base with $BASE; falling back to whole-repo mode"
      MODE="repo"
    else
      emit DIFF_BASE "$DIFF_BASE"
      FILES="$(git_safe diff --no-ext-diff --no-textconv --name-only --diff-filter=d "$DIFF_BASE" HEAD 2>/dev/null; git_safe diff --no-ext-diff --no-textconv --name-only --diff-filter=d 2>/dev/null)"
      FILES="$(printf '%s\n' "$FILES" | sort -u | sed '/^$/d')"
      STAT="$(git_safe diff --no-ext-diff --no-textconv --shortstat "$DIFF_BASE" 2>/dev/null || echo "")"
      INS="$(printf '%s' "$STAT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)"
      DEL="$(printf '%s' "$STAT" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)"
      emit DIFF_LINES "$(( INS + DEL ))"
    fi
  fi
fi

if [ "$MODE" = "repo" ]; then
  FILES="$(git_safe ls-files 2>/dev/null || find . -type f -not -path './.git/*' | sed 's|^\./||')"
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
#
# GENERATED_DIRS is the one list behind both this filter and the --exclude-dir flags
# `declared()` builds below. A build directory does not just carry a catalogue string --
# `.next/standalone/package.json` is Next.js's own verbatim copy of whatever manifest
# produced the build, a real dependency list that is not this project's declared scope.
# `declared()` used to search the whole working directory with only node_modules
# excluded, so a generated copy of package.json read as this project's own dependencies.
# One array feeding both exclusions is what keeps that from happening again by drift:
# a directory added here is a directory `declared()` also skips, with no second edit.
GENERATED_DIRS=(node_modules dist build .next .nuxt .output .svelte-kit .astro .vercel .turbo .amplify-hosting coverage)
_gen_re=""
for _d in "${GENERATED_DIRS[@]}"; do
  _gen_re="${_gen_re:+$_gen_re|}(^|/)${_d//./\\.}/"
done
GENERATED_EXCLUDE_RE="${_gen_re}|\\.min\\.js\$|\\.map\$"

SRC="$(printf '%s\n' "${FILES:-}" \
  | grep -Ev "$GENERATED_EXCLUDE_RE" \
  | sed '/^$/d')"

# Symbolic links are not reviewed, matching the engine. `git ls-files` lists a
# committed link, and `[ -f ]` follows it, so a link to a file outside the
# repository used to be grepped -- and could raise SIGNAL_TRACKERS_NO_CONSENT,
# the one line this script asserts, from a file that is not the repository's.
# A path is dropped when it is a link or sits under a linked directory. Paths
# are passed through the environment, not `awk -v`, which rewrites backslashes.
LINKED="$(find . \( -name .git -o -name node_modules \) -prune -o -type l -print 2>/dev/null | sed 's|^\./||')"
if [ -n "$LINKED" ]; then
  SRC="$(printf '%s\n' "$SRC" | LINKED="$LINKED" awk '
    BEGIN { n = split(ENVIRON["LINKED"], link, "\n") }
    { for (i = 1; i <= n; i++) if (link[i] != "" && ($0 == link[i] || index($0, link[i] "/") == 1)) next; print }')"
fi
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

# `--list`: the reviewed file set and nothing else, so specialists read exactly
# what the gates read without running git in the repository themselves.
if [ "$LIST" = 1 ]; then
  printf '%s\n' "$EXISTING" | sed '/^$/d'
  exit 0
fi

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
#
# Every file list below is passed after `--`. The list comes from the reviewed
# repository, which is arbitrary third-party source, and a filename is allowed
# to look exactly like an option. Without the terminator a file named `-i.js`
# reaches `sed` as its in-place flag and this read-only review rewrites the
# files it was asked to read; a file named `--regexp=^|z.js` reaches `grep` as
# a pattern and turns every content gate true on a repository containing none
# of the things they test for. Both were demonstrated, not theorised.

# Runs grep over the reviewed CODE set. $1 is the pattern.
hits() {
  [ -z "$CODE" ] && return 1
  GATE_OUT="$(printf '%s\n' "$CODE" | tr '\n' '\0' \
    | xargs -0 -r sh -c 'grep -lIE "$0" -- "$@" 2>/dev/null; s=$?; [ "$s" -le 1 ] && exit 0; exit 255' "$1" 2>/dev/null)"
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
  # The search runs on its own line so GATE_STATUS is *its* status. Filtering it
  # in the same pipeline would report the rightmost non-zero instead: a genuine
  # failure in the search (exit 2) followed by a filter that matches nothing
  # (exit 1) yields 1, which reads as a healthy no-match and never reaches the
  # `>1` branch that prints SCOPE_DEGRADED. That is the same silent-failure
  # shape the rest of this file was rewritten to remove, and it hid here because
  # this is the only helper whose pipeline continues past the search.
  #
  # `--exclude-dir` rather than filtering the result: the walk is what must not
  # read the directory. Filtering afterwards still opens every installed or
  # generated package.json, which contradicts the invariant in CLAUDE.md for
  # node_modules, costs time proportional to an installed tree rather than the
  # reviewed source, and matches a directory name anywhere in a path rather
  # than as a path component. GENERATED_DIRS (built above, beside the SRC
  # filter it also drives) supplies every flag here, not just node_modules --
  # a build directory carries a verbatim copy of whatever manifest produced
  # it, so excluding it from the file set but not from this whole-repo walk
  # left exactly the gap `.next/standalone/package.json` fell through.
  _d_exclude_flags=()
  for _d in "${GENERATED_DIRS[@]}"; do
    _d_exclude_flags+=("--exclude-dir=$_d")
  done
  _d_found="$(grep -rIlE "$1" --include=package.json "${_d_exclude_flags[@]}" . 2>/dev/null)"
  GATE_STATUS=$?
  GATE_OUT="$(printf '%s' "$_d_found" \
    | { [ -n "${SELF_REL:-}" ] && grep -v "^\./${SELF_REL}/" || cat; })"
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
#
# The search ends in `grep -q`, which is what the rest of this file was rewritten
# to remove -- but here it is correct, and the difference is the shell it runs in.
# The original bug was `pipefail` promoting the writer's SIGPIPE to the pipeline
# status. Inside this `sh -c` there is no `pipefail`, so `sed` taking SIGPIPE when
# `grep` stops early is what is supposed to happen and the status is grep's own.
#
# Without the early exit this function reads every byte of every file in a family
# even once it has its answer: measured at 4ms against 508ms on one 49 MB file,
# and it captured every matching line -- about 1.6 MB for that file -- into a
# shell variable to decide a boolean. Now it stops at the first match and reports
# one character.
#
# Error handling mirrors hits(): grep's own status is mapped inside the batch,
# and only a genuine failure becomes 255, which xargs reports distinctly as 124.
hits_live() {
  [ -z "$CODE" ] && return 1
  _hl_worst=1
  for _hl_fam in hash markup pug slash; do
    _hl_files="$(printf '%s\n' "$CODE" | grep -E "$(_comment_exts "$_hl_fam")")"
    [ -z "$_hl_files" ] && continue
    GATE_OUT="$(printf '%s\n' "$_hl_files" | tr '\n' '\0' \
      | xargs -0 -r env \
          _HL_SED="$(_comment_sed "$_hl_fam")" _HL_PAT="$1" \
          sh -c '
            sed -E "$_HL_SED" -- "$@" 2>/dev/null | grep -qaE "$_HL_PAT"
            s=$?
            [ "$s" -eq 0 ] && { printf M; exit 0; }
            [ "$s" -eq 1 ] && exit 0
            exit 255
          ' sh 2>/dev/null)"
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
gate SCOPE_SESSION_REPLAY hits 'logrocket|fullstory|@microsoft/clarity|hotjar|smartlook|session_?[Rr]ecording|record[Cc]anvas|maskAllInputs|replayIntegration|replaysSessionSampleRate|replaysOnErrorSampleRate|@sentry/replay|rrweb|sessionReplaySampleRate|startSessionReplayRecording|new (Sentry\.)?Replay\('

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
