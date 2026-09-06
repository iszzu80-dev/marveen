#!/usr/bin/env bash
# Cut the dashboard runtime over to a candidate sha, artifact-first.
#
# WHY THIS EXISTS (Istvan, 2026-09-06, P0 release-integrity):
#
#     "candidate build külön immutable release directoryba, majd atomic cutover
#      arra. Ne buildelj közvetlenül az aktív dist fölé."
#
# Because on 2026-09-06 I did exactly that. A plain `npx tsc` in the live
# checkout replaced the active `dist/` with a build of a different commit while
# the pin went on declaring the old one. The running process was unharmed only
# because it had loaded the old code hours earlier; a restart would have shipped
# unapproved code, and the release gate said exit 0 the whole time.
#
# THE SHAPE OF THE FIX. A build never lands on the active runtime. It lands in
# `releases/dist-<sha>/`, which is then made read-only, measured, and only then
# does `dist` -- a SYMLINK from here on -- start pointing at it. Rolling back is
# re-pointing the symlink at a directory that still exists, not a rebuild.
#
# WHAT THIS REFUSES TO DO, each for a reason paid for at least once:
#   * build from a dirty tree, or from a HEAD that is not the requested sha --
#     "which commit is this artifact" must have one answer;
#   * overwrite an existing release directory -- an immutable artifact that gets
#     rebuilt in place is not immutable, it just has a longer name;
#   * declare the cutover done without measuring the deployed tree AFTER the
#     restart. A cutover that ends at "the files are in place" is the thing that
#     failed today.
#
# USAGE:  scripts/cos-dist-cutover.sh <full-sha> [--dry-run]
set -uo pipefail

REPO="${MARVEEN_REPO_ROOT:-$HOME/marveen}"
PIN="$REPO/releases/dashboard-runtime-pin.json"
SERVICE="${MARVEEN_DASHBOARD_SERVICE:-marveen-dashboard.service}"
SHA="${1:-}"
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1

die() { printf 'REFUSED: %s\n' "$1" >&2; exit 1; }
say() { printf '==> %s\n' "$1"; }

[ -n "$SHA" ] || die "usage: cos-dist-cutover.sh <full-sha> [--dry-run]"
[ ${#SHA} -eq 40 ] || die "give the FULL 40-character sha; a short sha is a guess about which commit this artifact is"

cd "$REPO" || die "cannot enter $REPO"

# ---- 1. the source must be exactly, provably, the requested commit ----------
HEAD_SHA="$(git rev-parse HEAD)"
[ "$HEAD_SHA" = "$SHA" ] || die "HEAD is $HEAD_SHA but the cutover was asked for $SHA"
DIRTY="$(git status --porcelain --untracked-files=no)"
[ -z "$DIRTY" ] || die "the working tree has uncommitted tracked changes; the artifact could not say which commit it is:
$DIRTY"

SHORT="${SHA:0:9}"
TARGET="$REPO/releases/dist-$SHORT"
STAGE="$REPO/releases/.dist-$SHORT.staging.$$"

[ -e "$TARGET" ] && die "$TARGET already exists; an immutable artifact is never rebuilt in place. Remove it deliberately if you really mean to replace it."

say "candidate  $SHA"
say "artifact   $TARGET"
say "service    $SERVICE"
[ $DRY -eq 1 ] && say "DRY RUN: it WILL build and measure, then throw the result away. Nothing is sealed, swapped or restarted."

# ---- 2. build into a staging directory, never onto the live runtime ---------
# Staging, not the target, so a build that dies half-way leaves no directory
# that looks like a finished artifact.
#
# A dry run builds too, and that is the point of it: the question a dry run has
# to answer is "does this commit produce the artifact we expect", and a dry run
# that skips the build answers nothing at all.
if true; then
  rm -rf "$STAGE"
  say "building into $STAGE"
  npx tsc --outDir "$STAGE" || { rm -rf "$STAGE"; die "build failed; nothing was changed"; }

  # tsc emits only what it compiles. Anything the runtime reads from dist but
  # does not compile (static web assets and the like) is copied from the artifact
  # being replaced, and the copy is REPORTED rather than assumed: if this number
  # is ever surprising, the build is not self-contained and that is worth knowing.
  CURRENT="$(readlink -f "$REPO/dist" 2>/dev/null || echo "$REPO/dist")"
  if [ -d "$CURRENT" ]; then
    COPIED=0
    while IFS= read -r -d '' f; do
      rel="${f#$CURRENT/}"
      case "$rel" in .artifact-manifest.json) continue ;; esac
      if [ ! -e "$STAGE/$rel" ]; then
        mkdir -p "$STAGE/$(dirname "$rel")"
        cp -a "$f" "$STAGE/$rel"
        COPIED=$((COPIED + 1))
      fi
    done < <(find "$CURRENT" -type f -print0)
    say "carried over $COPIED non-compiled file(s) from the previous artifact"
  fi

  python3 "$REPO/scripts/artifact-manifest.py" "$STAGE" --write "$SHA" >/dev/null \
    || { rm -rf "$STAGE"; die "could not write the artifact manifest"; }

  if [ $DRY -eq 0 ]; then
    mv -T "$STAGE" "$TARGET" || { rm -rf "$STAGE"; die "could not place the artifact at $TARGET"; }
    chmod -R a-w "$TARGET"
    say "artifact sealed read-only"
    MEASURE_DIR="$TARGET"
  else
    MEASURE_DIR="$STAGE"
  fi
fi

MEASURED="$(python3 "$REPO/scripts/artifact-manifest.py" "$MEASURE_DIR" 2>/dev/null || true)"
TREE="$(printf '%s' "$MEASURED" | python3 -c "import json,sys;print(json.load(sys.stdin)['treeHash'])" 2>/dev/null || true)"
COUNT="$(printf '%s' "$MEASURED" | python3 -c "import json,sys;print(json.load(sys.stdin)['fileCount'])" 2>/dev/null || true)"
[ -n "$TREE" ] || die "could not measure $TARGET"
say "artifact identity $TREE ($COUNT files)"

if [ $DRY -eq 1 ]; then
  CUR="$(python3 "$REPO/scripts/artifact-manifest.py" "$(readlink -f "$REPO/dist")" 2>/dev/null \
        | python3 -c "import json,sys;print(json.load(sys.stdin)['treeHash'])" 2>/dev/null || echo '(unmeasurable)')"
  say "deployed now: $CUR"
  say "would deploy: $TREE"
  [ "$CUR" = "$TREE" ] && say "IDENTICAL -- this cutover would change nothing" || say "DIFFERENT -- this cutover would change the runtime"
  rm -rf "$STAGE"
  say "dry run complete, staging removed"
  exit 0
fi

# ---- 3. stop, swap, start --------------------------------------------------
# The swap happens with the service DOWN. `dist` is a real directory the first
# time and a symlink afterwards, and there is no ordering of mv/ln that is atomic
# across that transition -- so instead of pretending, the window is placed where
# nothing is reading.
PREV="$(readlink -f "$REPO/dist" 2>/dev/null || true)"
STAMP="$(date +%Y%m%dT%H%M%S)"

say "stopping $SERVICE"
systemctl --user stop "$SERVICE" || die "could not stop $SERVICE; nothing was swapped"

if [ -L "$REPO/dist" ]; then
  ln -sfn "$TARGET" "$REPO/dist.swap.$$" && mv -Tf "$REPO/dist.swap.$$" "$REPO/dist"
else
  mv -T "$REPO/dist" "$REPO/dist.pre-$SHORT-$STAMP" || die "could not set the previous runtime aside"
  ln -s "$TARGET" "$REPO/dist"
fi
say "dist -> $(readlink "$REPO/dist")"

python3 - "$PIN" "$SHA" "$TREE" "$COUNT" "$PREV" <<'PY'
import json, sys
pin_path, sha, tree, count, prev = sys.argv[1:6]
pin = json.load(open(pin_path, encoding='utf-8'))
pin['previousActivationCandidateSha'] = pin.get('activationCandidateSha')
pin['previousRuntime'] = prev
pin['activationCandidateSha'] = sha
pin['gateSha'] = sha
pin['distTreeHash'] = tree
pin['distFileCount'] = int(count)
json.dump(pin, open(pin_path, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print(f"pin now declares {sha[:9]} / {tree[:16]} / {count} files")
PY

say "starting $SERVICE"
systemctl --user start "$SERVICE" || die "the service did not start; dist is already swapped -- roll back by re-pointing it at $PREV"

# ---- 4. readback, after the restart, or it is not a cutover -----------------
# The gate is the readback: it re-measures the deployed tree against the pin and
# requires that nothing in it is newer than the process now running it. A cutover
# that stops before this has moved files and proven nothing.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f "node .*$REPO/dist/index.js" >/dev/null 2>&1 && break
  sleep 2
done

say "readback"
if bash "$REPO/scripts/cos-cycle-preflight.sh" --verify-only; then
  say "CUTOVER VERIFIED"
else
  die "the gate refuses after the restart; the runtime is NOT verified as $SHORT"
fi
