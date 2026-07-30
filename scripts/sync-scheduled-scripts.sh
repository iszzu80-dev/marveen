#!/usr/bin/env bash
# sync-scheduled-scripts.sh — pin the scheduled-task layer's script dependencies
# to a release directory, independent of whatever branch the shared checkout
# happens to be on.
#
# Card d3f9fd90 (2026-07-20): 3 scheduled tasks (email-triage, memoria-heartbeat,
# context-watchdog) invoke scripts/*.{py,sh} via a path rooted at the shared
# ~/marveen checkout. Any agent's branch switch there can make those files
# vanish for every other agent's scheduled tasks (already happened once, via
# costops-rebased). Same root cause as the memory-pressure monitor's
# INSTALL_DIR bug (fixed ec5524d) and install-monitor.sh's releases/ pattern —
# applied one layer up.
#
# Unlike install-monitor.sh (which copies from the CURRENTLY CHECKED OUT
# working tree), this reads file content via `git show <ref>:<path>` — so a
# branch switch mid-sync cannot pick up wrong/partial content, only a
# nonexistent ref would fail loudly.
#
# Usage:
#   sync-scheduled-scripts.sh [ref]   # default ref: develop
#   sync-scheduled-scripts.sh --rollback
#   sync-scheduled-scripts.sh --status
#   sync-scheduled-scripts.sh --list

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASES_DIR="$REPO_ROOT/releases"
CURRENT_LINK="$RELEASES_DIR/scheduled-scripts-current"
PREVIOUS_LINK="$RELEASES_DIR/scheduled-scripts-previous"
MANIFEST_FILE="release.json"

# Sourced from the git ref (branch-switch-immune by construction: content
# comes from the commit object, not the working tree).
GIT_FILES=(
  "scripts/email-triage-fetch.py"
  "scripts/skill-index.sh"
)

# dispatch-guard.sh is intentionally untracked on this branch (see
# .git/info/exclude) — it diverged from fork/main and was deliberately kept
# local-only (see backup/local-dispatch-guard-* branches) to avoid a merge
# silently overwriting the local safety behavior. `git show <ref>:...` cannot
# see it. Copy it from the live working tree instead: as an untracked file it
# is already immune to `git checkout <branch>` on this repo (no branch here
# ever supplies a competing blob at this path), so the working-tree copy is
# reliable at sync time. A dirty edit in flight would still land in the
# release, which is why --status/--list record the exact bytes installed.
DISK_FILES=(
  "scripts/dispatch-guard.sh"
)

die() { echo "ERROR: $*" >&2; exit 1; }

current_target() {
  [ -L "$CURRENT_LINK" ] && readlink "$CURRENT_LINK" || echo ""
}

if [ "${1:-}" = "--list" ]; then
  if [ -d "$RELEASES_DIR" ]; then
    for d in "$RELEASES_DIR"/scheduled-scripts-*/; do
      [ -d "$d" ] || continue
      basename "$d"
      [ -f "$d/$MANIFEST_FILE" ] && python3 -c "
import json
d = json.load(open('$d/$MANIFEST_FILE'))
print(f\"  ref:       {d.get('ref','?')}\")
print(f\"  commit:    {d.get('commit','?')}\")
print(f\"  installed: {d.get('installedAt','?')}\")
" 2>/dev/null || true
    done
  else
    echo "(no releases installed)"
  fi
  current=$(current_target)
  [ -n "$current" ] && echo "current → $current"
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  current=$(current_target)
  echo "current:  ${current:-NONE}"
  if [ -L "$PREVIOUS_LINK" ]; then
    echo "previous: $(readlink "$PREVIOUS_LINK")"
  else
    echo "previous: NONE"
  fi
  if [ -n "$current" ] && [ -f "$CURRENT_LINK/$MANIFEST_FILE" ]; then
    python3 -c "
import json
d = json.load(open('$CURRENT_LINK/$MANIFEST_FILE'))
print(f\"  ref:       {d.get('ref','?')}\")
print(f\"  commit:    {d.get('commit','?')}\")
print(f\"  installed: {d.get('installedAt','?')}\")
print(f\"  files:     {len(d.get('files', []))} entries\")
" 2>/dev/null || true
  fi
  exit 0
fi

if [ "${1:-}" = "--rollback" ]; then
  [ -L "$PREVIOUS_LINK" ] || die "no previous release to roll back to"
  prev_target=$(readlink "$PREVIOUS_LINK")
  prev_dir="$RELEASES_DIR/$prev_target"
  [ -d "$prev_dir" ] || die "previous release directory $prev_dir does not exist"

  current=$(current_target)
  echo "Rolling back: $prev_target (current was: ${current:-NONE})"
  if [ -n "$current" ] && [ -d "$RELEASES_DIR/$current" ]; then
    ln -sfn "$current" "$PREVIOUS_LINK"
  fi
  ln -sfn "$prev_target" "$CURRENT_LINK"
  echo "current now: $prev_target"
  exit 0
fi

# ── install (default) ────────────────────────────────────────────────────────

SOURCE_REF="${1:-develop}"

COMMIT=$(git -C "$REPO_ROOT" rev-parse "$SOURCE_REF" 2>/dev/null) || die "unknown ref: $SOURCE_REF"
SHORT="${COMMIT:0:9}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RELEASE_ID="scheduled-scripts-${SHORT}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"

mkdir -p "$RELEASE_DIR"

MANIFEST_FILES="["
first=1
for f in "${GIT_FILES[@]}"; do
  base="$(basename "$f")"
  git -C "$REPO_ROOT" show "$SOURCE_REF:$f" > "$RELEASE_DIR/$base" 2>/dev/null \
    || die "missing $f at $SOURCE_REF (git show failed)"
  chmod +x "$RELEASE_DIR/$base"
  [ "$first" = 1 ] && first=0 || MANIFEST_FILES="$MANIFEST_FILES,"
  MANIFEST_FILES="$MANIFEST_FILES\"$base (git:$SOURCE_REF)\""
done
for f in "${DISK_FILES[@]}"; do
  base="$(basename "$f")"
  [ -f "$REPO_ROOT/$f" ] || die "missing $f on disk at $REPO_ROOT (untracked dependency absent)"
  cp "$REPO_ROOT/$f" "$RELEASE_DIR/$base"
  chmod +x "$RELEASE_DIR/$base"
  [ "$first" = 1 ] && first=0 || MANIFEST_FILES="$MANIFEST_FILES,"
  MANIFEST_FILES="$MANIFEST_FILES\"$base (disk:working-tree)\""
done
MANIFEST_FILES="$MANIFEST_FILES]"

cat > "$RELEASE_DIR/$MANIFEST_FILE" << MANIFEST
{
  "releaseId": "$RELEASE_ID",
  "ref": "$SOURCE_REF",
  "commit": "$COMMIT",
  "installedAt": "$TIMESTAMP",
  "builtFrom": "scripts/sync-scheduled-scripts.sh",
  "files": $MANIFEST_FILES
}
MANIFEST

current=$(current_target)
if [ -n "$current" ] && [ -d "$RELEASES_DIR/$current" ]; then
  ln -sfn "$current" "$PREVIOUS_LINK"
  echo "Saved previous: $current"
fi

ln -sfn "$RELEASE_ID" "$CURRENT_LINK"
echo "=== Installed $RELEASE_ID → releases/scheduled-scripts-current ==="
echo "  ref:       $SOURCE_REF"
echo "  commit:    $COMMIT"
echo "  timestamp: $TIMESTAMP"
echo ""
echo "Scheduled tasks resolve dispatch-guard.sh / skill-index.sh / email-triage-fetch.py here."
echo "Rollback available: scripts/sync-scheduled-scripts.sh --rollback"
