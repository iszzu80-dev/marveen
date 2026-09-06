#!/usr/bin/env bash
# Run the COS cycle from the PINNED activation release, or refuse loudly.
#
# WHY THIS EXISTS (Istvan, 2026-08-24). After the Stage 2G cutover the HTTP/intake
# surface and the triage feeder both ran the pinned candidate, while the scheduled
# cycle still ran whatever `develop` happened to be. Nothing broke, and that is the
# problem: the pinned cycle adds counter normalisation with an explicit UNKNOWN
# outcome for a step that exits 0 while exposing no trustworthy counters. So the
# old version's `problems: []` and the new version's `problems: []` are different
# statements, and only one of them can tell "ran and found nothing" apart from
# "ran and we cannot tell what it did".
#
# THE TRAP THIS AVOIDS. The obvious fix -- run the cycle from the git worktree that
# sits on the candidate branch -- is worse than the disease. `STORE_DIR` is derived
# from the module's own location, so a cycle run from a worktree opens
# <worktree>/store/claudeclaw.db, which does not exist. SQLite would create an
# empty one, every step would find nothing, and `problems: []` would be reported
# over a database with no data in it. That is a false green that looks exactly like
# a healthy night. The worktree is also where the test suite runs, so pointing its
# store at production would risk a test writing to the live database.
#
# So the cycle runs from a RELEASE directory built with `git archive <sha>`: a
# copy, not a worktree, that no branch switch and no test run can move.
#
# Every check below fails CLOSED. A cycle that cannot prove which code it is is
# not a cycle that found nothing.
set -uo pipefail

REPO="${MARVEEN_REPO_ROOT:-$HOME/marveen}"
RELEASE="$REPO/releases/cos-cycle-current"
RUNTIME_PIN="$REPO/releases/dashboard-runtime-pin.json"
FEEDER="$REPO/releases/scheduled-scripts-current/email-triage-fetch.py"

fail() { printf '{"pinnedCycle":"REFUSED","reason":%s}\n' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >&2; exit 90; }

# 0. FIRST: the guard checks the PREFLIGHT that launched it.
#
#    ORDER IS THE POINT, and it was wrong until 2026-08-26. This check used to
#    sit LAST, after the four release checks -- so a tampered preflight was only
#    noticed when the release state happened to be valid. Any release problem
#    would mask it: the guard would report the release fault and never look at
#    the gate it is half of. Found by writing the acceptance test for exactly
#    this control, which could not reach the check in a fixture with no release.
#
#    A gate verifies ITSELF before it verifies anything else.
#
#    The preflight hashes this guard before exec'ing it; this closes the other
#    half, so neither of the two can drift without the other noticing. Both
#    digests live in the pin file, which makes the pin -- not either script --
#    the single statement of what the release-gate IS.
#
#    This is a closed circle, not an infinite chain of trust, and its boundary is
#    write access to the repository. Said plainly rather than dressed up: anyone
#    who can rewrite the pin AND both scripts is already past every gate here.
#    What it does buy is that a change to EITHER script alone fails loudly.
#    A pin written BEFORE this hardening carries no `preflightSha256`, and the
#    check tolerates that so the live cycle keeps running across the merge. But
#    the skip is REPORTED, not silent: an absent check that looks identical to a
#    passing one is this codebase's signature defect, and the whole point of the
#    exercise is to stop producing it. `preflightCheck` in the OK line says which
#    of the two happened, every run.
PREFLIGHT_WANT="$(python3 -c "import json;print(json.load(open('$RUNTIME_PIN')).get('preflightSha256',''))" 2>/dev/null || true)"
if [ -n "$PREFLIGHT_WANT" ]; then
  PREFLIGHT_HAVE="$(sha256sum "$REPO/scripts/cos-cycle-preflight.sh" 2>/dev/null | cut -d' ' -f1)"
  [ "$PREFLIGHT_WANT" = "$PREFLIGHT_HAVE" ] || fail "preflight launcher does not match the pin (want ${PREFLIGHT_WANT:0:12}, have ${PREFLIGHT_HAVE:0:12})"
  PREFLIGHT_STATE="verified"
else
  PREFLIGHT_STATE="SKIPPED_PIN_DECLARES_NO_PREFLIGHT"
fi

[ -d "$RELEASE" ] || fail "no pinned cycle release at $RELEASE"
RELEASE_SHA="$(cat "$RELEASE/.release-sha" 2>/dev/null || true)"
[ -n "$RELEASE_SHA" ] || fail "the release carries no .release-sha; it cannot say what it is"

# 1. The cycle and the HTTP/intake runtime must be the SAME sha, not merely both pinned.
RUNTIME_SHA="$(python3 -c "import json,sys; print(json.load(open('$RUNTIME_PIN'))['activationCandidateSha'])" 2>/dev/null || true)"
[ -n "$RUNTIME_SHA" ] || fail "cannot read activationCandidateSha from $RUNTIME_PIN"
[ "$RELEASE_SHA" = "$RUNTIME_SHA" ] || fail "cycle release $RELEASE_SHA != deployed runtime $RUNTIME_SHA"

# 2. The release content must still BE that sha. A hand edit in the release dir
#    would otherwise keep the marker's word while running something else.
WANT="$(git -C "$REPO" show "$RELEASE_SHA:scripts/cos-cycle.ts" 2>/dev/null | sha256sum | cut -d' ' -f1)"
HAVE="$(sha256sum "$RELEASE/scripts/cos-cycle.ts" 2>/dev/null | cut -d' ' -f1)"
[ -n "$WANT" ] && [ "$WANT" = "$HAVE" ] || fail "release content does not match $RELEASE_SHA (cos-cycle.ts hash differs)"

# 3. The store must be the LIVE database, compared by inode rather than by path:
#    a path can be a symlink to anywhere, an inode cannot lie about which file it is.
LIVE_INO="$(stat -c '%i' "$REPO/store/claudeclaw.db" 2>/dev/null || true)"
REL_INO="$(stat -c '%i' "$RELEASE/store/claudeclaw.db" 2>/dev/null || true)"
[ -n "$LIVE_INO" ] || fail "live database not found at $REPO/store/claudeclaw.db"
[ "$LIVE_INO" = "$REL_INO" ] || fail "the release store is NOT the live database (inode $REL_INO vs $LIVE_INO); a cycle here would report an empty store as healthy"

# 4. The feeder must come from the same sha too, so all three consumers agree.
#
#    CONTENT, then PROVENANCE -- and the second half is not decoration.
#    Until 2026-08-26 this check hashed the feeder file and stopped there, which
#    answers a weaker question than the pin's own stated purpose. The rollback
#    drill measured it: between 0011de922 and 1adf2a23 `email-triage-fetch.py` is
#    BYTE-IDENTICAL, so a feeder release left behind at the OLD candidate passed
#    under the NEW one. Behaviourally harmless -- identical bytes run identically
#    -- but "all three consumers are on this sha" was not what the green meant,
#    and the pin file's own correction note is explicit that "functionally
#    equivalent" is not "the same sha".
#
#    So the feeder release now carries a `.release-sha` marker of its own, and
#    the marker is checked as well as the content. Two independent ways to be
#    wrong, two checks.
FEEDER_WANT="$(git -C "$REPO" show "$RELEASE_SHA:scripts/email-triage-fetch.py" 2>/dev/null | sha256sum | cut -d' ' -f1)"
FEEDER_HAVE="$(sha256sum "$FEEDER" 2>/dev/null | cut -d' ' -f1)"
[ "$FEEDER_WANT" = "$FEEDER_HAVE" ] || fail "pinned feeder is not from $RELEASE_SHA (feeder hash differs)"

FEEDER_DIR="$(dirname "$FEEDER")"
FEEDER_SHA="$(cat "$FEEDER_DIR/.release-sha" 2>/dev/null || true)"
[ -n "$FEEDER_SHA" ] || fail "the pinned feeder release carries no .release-sha; it cannot say WHICH release it is, and identical bytes are not identical provenance"
[ "$FEEDER_SHA" = "$RELEASE_SHA" ] || fail "pinned feeder declares release $FEEDER_SHA but the cycle release is $RELEASE_SHA"

# 5. THE DEPLOYED ARTIFACT, MEASURED. "PIN DECLARES, ARTIFACT PROVES."
#
#    Checks 1-4 compare declarations: the pin says a sha, the release directory
#    says a sha, and they must agree. Not one of them ever looked at `dist/` --
#    the code the dashboard actually loads. On 2026-09-06 that gap was walked
#    straight through: a plain `npx tsc` in the live checkout replaced dist with
#    a build of a different commit, the pin was untouched, and twenty minutes
#    later this gate returned exit 0 over a runtime that was no longer the pinned
#    one. The running process was still fine only by luck -- it had loaded the
#    old code into memory hours earlier -- so a restart, a crash, or a systemd
#    reload would have deployed unapproved code silently, with the gate green.
#
#    A declaration cannot be wrong about itself. Only a measurement can.
#
#    The identity is the sha256 of the sorted `<file-sha256>  <relative-path>`
#    listing of the whole tree (scripts/artifact-manifest.py). Content and layout
#    both; mtimes and permissions deliberately not, so that two builds of one
#    source are one identity.
#
#    A pin that predates this hardening carries no `distTreeHash`. That is
#    tolerated so the live cycle survives the merge, and it is REPORTED, never
#    silent -- `distCheck` in the OK line says which of the two happened on every
#    single run. An absent check that reads like a passing one is the exact
#    defect this whole change exists to remove.
DIST="$REPO/dist"
DIST_WANT="$(python3 -c "import json;print(json.load(open('$RUNTIME_PIN')).get('distTreeHash',''))" 2>/dev/null || true)"
DIST_STATE="SKIPPED_PIN_DECLARES_NO_DIST_TREE_HASH"
DIST_HAVE=""
DIST_FILES=""
if [ -n "$DIST_WANT" ]; then
  [ -d "$DIST" ] || fail "the pin declares a distTreeHash but there is no $DIST to measure"
  MEASURED="$(python3 "$REPO/scripts/artifact-manifest.py" "$DIST" 2>/dev/null || true)"
  DIST_HAVE="$(printf '%s' "$MEASURED" | python3 -c "import json,sys;print(json.load(sys.stdin)['treeHash'])" 2>/dev/null || true)"
  DIST_FILES="$(printf '%s' "$MEASURED" | python3 -c "import json,sys;print(json.load(sys.stdin)['fileCount'])" 2>/dev/null || true)"
  [ -n "$DIST_HAVE" ] || fail "could not measure the deployed artifact at $DIST; an unmeasurable runtime is not a verified one"
  [ "$DIST_WANT" = "$DIST_HAVE" ] || fail "DEPLOYED ARTIFACT IS NOT THE PINNED ONE: dist tree hash ${DIST_HAVE:0:16} but the pin declares ${DIST_WANT:0:16}. The pin was not changed; the build was. Rebuild the pinned candidate or repin, but do not run."

  # 5b. The artifact's own claim about itself, when it makes one. It is checked
  #     against the RELEASE sha and against the measurement just taken -- never
  #     trusted on its own, since whatever can rewrite the tree can rewrite this
  #     file too. Its value is that it makes a stray directory self-describing.
  MANIFEST="$DIST/.artifact-manifest.json"
  if [ -f "$MANIFEST" ]; then
    M_SHA="$(python3 -c "import json;print(json.load(open('$MANIFEST')).get('releaseSha',''))" 2>/dev/null || true)"
    M_TREE="$(python3 -c "import json;print(json.load(open('$MANIFEST')).get('treeHash',''))" 2>/dev/null || true)"
    [ "$M_SHA" = "$RELEASE_SHA" ] || fail "the deployed artifact declares release $M_SHA but the release is $RELEASE_SHA"
    [ "$M_TREE" = "$DIST_HAVE" ] || fail "the deployed artifact's manifest claims tree ${M_TREE:0:16} but it measures ${DIST_HAVE:0:16}"
    DIST_STATE="verified+self-declared"
  else
    DIST_STATE="verified"
  fi
fi

# 6. FRESHNESS: is the running process actually running THIS artifact?
#
#    A matching hash is not enough on its own. Node reads its modules once, at
#    boot, and holds them in memory; a dist replaced afterwards leaves a process
#    running code that no longer exists on disk. On 2026-09-06 the reverse held
#    -- disk moved, memory did not -- and both directions are the same defect:
#    what runs and what is measured are two different things.
#
#    So: no file that is part of the identity may be newer than the moment the
#    runtime process started. The manifest is excluded because the cutover writes
#    it after the build, and its content is already cross-checked above.
#
#    If no runtime process is found, that is REPORTED as its own state and not
#    counted as a pass. The cycle itself does not need the dashboard to be up, so
#    this does not refuse -- but "we could not check" must never render as "we
#    checked and it was fine".
RUNTIME_PID="$(pgrep -f "node .*${REPO}/dist/index.js" 2>/dev/null | head -1 || true)"
if [ -z "$RUNTIME_PID" ]; then
  FRESH_STATE="NO_RUNTIME_PROCESS_NOT_CHECKED"
elif [ -z "$DIST_HAVE" ]; then
  FRESH_STATE="SKIPPED_NO_DIST_MEASUREMENT"
else
  PROC_START="$(stat -c '%Y' "/proc/$RUNTIME_PID" 2>/dev/null || true)"
  NEWEST="$(find "$DIST" -type f ! -name '.artifact-manifest.json' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)"
  if [ -z "$PROC_START" ] || [ -z "$NEWEST" ]; then
    FRESH_STATE="UNMEASURABLE_NOT_CHECKED"
  elif [ "$NEWEST" -gt "$PROC_START" ]; then
    fail "the deployed artifact was modified AFTER the runtime started (newest dist file $NEWEST > process $RUNTIME_PID start $PROC_START); the process is running code that is no longer on disk"
  else
    FRESH_STATE="verified"
  fi
fi

printf '{"pinnedCycle":"OK","releaseSha":"%s","runtimeSha":"%s","feederSha256":"%s","feederRelease":"%s","preflightCheck":"%s","storeInode":"%s","distCheck":"%s","distTreeHash":"%s","distFileCount":"%s","runtimeFreshness":"%s"}\n' \
  "$RELEASE_SHA" "$RUNTIME_SHA" "${FEEDER_HAVE:0:16}" "${FEEDER_SHA:0:9}" "$PREFLIGHT_STATE" "$LIVE_INO" "$DIST_STATE" "${DIST_HAVE:0:16}" "$DIST_FILES" "$FRESH_STATE" >&2

# --verify-only exists so the checks can be exercised (and their refusals proven)
# without paying for a full cycle. A guard nobody can cheaply drive into the red
# is a guard nobody checks.
if [ "${1:-}" = "--verify-only" ]; then exit 0; fi

cd "$RELEASE" || fail "cannot enter $RELEASE"
exec npx tsx scripts/cos-cycle.ts "$@"
