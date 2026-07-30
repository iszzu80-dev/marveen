#!/usr/bin/env bash
# run-script-tests.sh -- discovers and runs every scripts/__tests__/*.{sh,py}
# integration/contract test, reports per-file PASS/FAIL, and exits non-zero
# on any failure.
#
# Card de8c7cad (2026-07-30): scripts/__tests__/ held 17 test files with NO
# runner anywhere -- no package.json script, no CI workflow, no shell loop.
# They ran only when a human happened to type the exact path. Several guard
# every one of those files as they are found (never re-triaged, never
# silently deleted): several guard subsystems that fail SILENTLY in
# production (channel-inbox-drain, telegram-watchdog-wedged,
# stuck-modal-guard, disk-space-guard, channels-auth-probe,
# inter-agent-evidence-gate) had zero execution coverage despite a test file
# existing -- a guard that never runs is worse than no guard, because its
# existence gets read as coverage.
#
# Usage:
#   scripts/run-script-tests.sh                # routine sweep (default)
#   scripts/run-script-tests.sh --include-slow  # also runs the Docker-based
#                                                # voice-install acceptance test
#
# Exit code: 0 = every RUN file passed (skips do not count against this).
#            1 = at least one file failed, OR discovery found zero files
#                (a runner that silently discovers nothing would recreate
#                this exact problem one layer up).

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$REPO_ROOT/scripts/__tests__"

INCLUDE_SLOW=0
if [ "${1:-}" = "--include-slow" ]; then INCLUDE_SLOW=1; fi

# Skip list: filename -> reason. Every skip is DOCUMENTED and printed on every
# run, never silent. Do not add an entry here to make a real failure go away
# -- a skip is for a test that cannot safely/cheaply run in a routine sweep,
# not for a test that is currently red.
declare -A SKIP_REASONS=(
  ["test-voice-install.sh"]="requires a real Docker container (docker run ubuntu:24.04, network image pull, ~minutes) and leaves that container running afterward for manual inspection by design -- not suitable for a routine sweep. Run explicitly: bash scripts/__tests__/test-voice-install.sh (or pass --include-slow to this runner)."
)

mapfile -t FILES < <(find "$TEST_DIR" -maxdepth 1 -type f \( -name '*.sh' -o -name '*.py' \) | sort)

DISCOVERED=${#FILES[@]}
if [ "$DISCOVERED" -eq 0 ]; then
  echo "FATAL: discovered 0 test files under $TEST_DIR -- the runner or the directory moved" >&2
  exit 1
fi

RAN=0; PASSED=0; FAILED=0; SKIPPED=0
FAILED_NAMES=()
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

for f in "${FILES[@]}"; do
  name="$(basename "$f")"
  reason="${SKIP_REASONS[$name]:-}"
  if [ -n "$reason" ] && [ "$INCLUDE_SLOW" -eq 0 ]; then
    echo "SKIP  $name"
    echo "      $reason"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  RAN=$((RAN + 1))
  echo "=== $name ==="
  : > "$LOG"
  case "$name" in
    *.py) python3 "$f" > "$LOG" 2>&1; rc=$? ;;
    *.sh) bash "$f" > "$LOG" 2>&1; rc=$? ;;
    *) rc=127; echo "no runner for extension" > "$LOG" ;;
  esac

  if [ "$rc" -eq 0 ]; then
    PASSED=$((PASSED + 1))
    echo "  PASS"
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
    echo "  FAIL (exit $rc) -- last 30 lines:"
    tail -30 "$LOG" | sed 's/^/    /'
  fi
done

echo ""
echo "======================================"
echo "Discovered: $DISCOVERED   Ran: $RAN   Passed: $PASSED   Failed: $FAILED   Skipped: $SKIPPED"
if [ "$FAILED" -gt 0 ]; then
  echo "FAILED: ${FAILED_NAMES[*]}"
  exit 1
fi
exit 0
