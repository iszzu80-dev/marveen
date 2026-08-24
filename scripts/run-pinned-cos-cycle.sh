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
FEEDER_WANT="$(git -C "$REPO" show "$RELEASE_SHA:scripts/email-triage-fetch.py" 2>/dev/null | sha256sum | cut -d' ' -f1)"
FEEDER_HAVE="$(sha256sum "$FEEDER" 2>/dev/null | cut -d' ' -f1)"
[ "$FEEDER_WANT" = "$FEEDER_HAVE" ] || fail "pinned feeder is not from $RELEASE_SHA (feeder hash differs)"

printf '{"pinnedCycle":"OK","releaseSha":"%s","runtimeSha":"%s","feederSha256":"%s","storeInode":"%s"}\n' \
  "$RELEASE_SHA" "$RUNTIME_SHA" "${FEEDER_HAVE:0:16}" "$LIVE_INO" >&2

# --verify-only exists so the checks can be exercised (and their refusals proven)
# without paying for a full cycle. A guard nobody can cheaply drive into the red
# is a guard nobody checks.
if [ "${1:-}" = "--verify-only" ]; then exit 0; fi

cd "$RELEASE" || fail "cannot enter $RELEASE"
exec npx tsx scripts/cos-cycle.ts "$@"
