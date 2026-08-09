#!/usr/bin/env bash
# scheduled-task-dependency-check.sh — regression guard for card d3f9fd90.
#
# Scans ~/.claude/scheduled-tasks/ for any task that still invokes a
# scripts/*.{py,sh,mjs} dependency rooted at the shared, branch-switchable
# ~/marveen checkout instead of the pinned releases/scheduled-scripts-current/
# copy. This is the "assert the names differ, not just that they're
# non-empty" check for this layer, mirroring the monitor's T8 bundle-grep
# test (ec5524d): a check that merely confirms a script PATH is non-empty
# would pass even in the broken state. This asserts the path does NOT point
# at the mutable checkout.
#
# A hit here means: someone added a new scheduled task (or edited an
# existing one) that reintroduced the exact hazard this card fixed. Either
# repoint it at releases/scheduled-scripts-current/ (add the file to
# sync-scheduled-scripts.sh's GIT_FILES/DISK_FILES first if new), or add a
# narrowly-scoped allowlist entry below with a reason -- do not blanket-allow.
#
# Exit 0 = clean. Exit 1 = violation(s) found (printed).
#
# Usage: scheduled-task-dependency-check.sh

set -euo pipefail

SCHED_DIR="$HOME/.claude/scheduled-tasks"
[ -d "$SCHED_DIR" ] || { echo "no scheduled-tasks dir at $SCHED_DIR"; exit 0; }

# Matches: scripts/<name>.py|.sh|.mjs referenced as a path component.
PATTERN='scripts/[A-Za-z0-9_.-]+\.(py|sh|mjs)'

violations=0
files_scanned=0

while IFS= read -r -d '' f; do
  files_scanned=$((files_scanned + 1))
  # grep -n for line numbers; -E for the pattern above.
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    lineno="${line%%:*}"
    content="${line#*:}"

    # Already pinned -> fine.
    case "$content" in
      *releases/scheduled-scripts-current/*) continue ;;
    esac
    # Docs-only pointer to the sync tool itself (not an executed dependency
    # of the task's own recipe) -> fine.
    case "$content" in
      *sync-scheduled-scripts.sh*) continue ;;
    esac

    echo "VIOLATION: $f:$lineno: $content"
    violations=$((violations + 1))
  done < <(grep -nE "$PATTERN" "$f" 2>/dev/null || true)
done < <(find "$SCHED_DIR" -type f \( -name '*.md' -o -name '*.sh' -o -name '*.py' -o -name '*.mjs' \) -print0)

echo "---"
echo "Scanned $files_scanned scheduled-task file(s)."
if [ "$violations" -gt 0 ]; then
  echo "FAIL: $violations live-checkout scripts/ dependency reference(s) found."
  exit 1
fi
echo "OK: 0 live-checkout scripts/ dependencies found."
exit 0
