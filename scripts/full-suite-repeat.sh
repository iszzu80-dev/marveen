#!/usr/bin/env bash
#
# E4 instrumentation — run the full suite N times and KEEP every byte.
#
# The Phase 1 open item was never "a test fails sometimes". It was that a test
# failed once and could not be named, because the command that ran it truncated
# its own output. The instrument was the defect. This script is the instrument,
# committed, so the next person hunting a flake does not have to reinvent it and
# does not get to lose the evidence.
#
# Two rules it exists to enforce:
#   1. EVERY run's complete output goes to its own file BEFORE anything reads a
#      summary. A pipe into `tail` is how the first one was lost.
#   2. A failing run does NOT stop the batch. The owner's reopen condition says
#      "do not rerun blindly to green"; a batch that halts on the first red
#      tells you nothing about the rate, and the rate is the question.
#
# Usage:
#   scripts/full-suite-repeat.sh [runs] [output-dir]
#   scripts/full-suite-repeat.sh 20 deliverables/e4-suite-output
#
# Reading the result: SUMMARY.txt has one line per run with its exit code and
# its Tests line. Non-zero rc, or a `Tests ... failed` line, means open the file
# named on that row -- it is complete, so classification (deterministic defect /
# flaky test / infrastructure) can be made from it without a rerun.
#
# On what N buys you, because "it looked quiet" is not a measurement: with zero
# failures in N runs the 95% one-sided upper bound on the true rate is
# 1 - 0.05^(1/N) -- about 26% at N=10, 14% at N=20, 6% at N=50. Twenty runs
# refute a 1-in-7 flake and say nothing at all about a 1-in-50 one. Print the
# bound with the result; a bare "20/20 clean" invites the reader to hear
# "fixed".
set -u

RUNS="${1:-20}"
OUT="${2:-deliverables/e4-suite-output}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
mkdir -p "$OUT"

SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git status --porcelain 2>/dev/null | head -1)"
{
  echo "sha=$SHA started=$(date -Is) runs=$RUNS"
  [ -n "$DIRTY" ] && echo "WARNING: working tree is DIRTY -- these runs are not the SHA above"
} > "$OUT/SUMMARY.txt"

fails=0
for i in $(seq 1 "$RUNS"); do
  f="$OUT/run-$(printf %02d "$i")-$(date +%Y%m%dT%H%M%S).txt"
  # `--exclude '**/.claude/**'`: this repo hosts other agents' git worktrees
  # under .claude/, and vitest's default include recurses into them.
  npx --yes vitest run --exclude '**/.claude/**' > "$f" 2>&1
  rc=$?
  [ "$rc" -ne 0 ] && fails=$((fails + 1))
  line=$(grep -E "^ *Tests  " "$f" | tail -1)
  echo "run $i rc=$rc | $line | $f" >> "$OUT/SUMMARY.txt"
done

{
  echo "finished=$(date -Is) failed_runs=$fails/$RUNS"
  if [ "$fails" -eq 0 ]; then
    python3 - "$RUNS" <<'PY' 2>/dev/null || true
import sys
n = int(sys.argv[1])
print(f"clean: {n}/{n}. 95% upper bound on the failure rate: "
      f"{(1 - 0.05 ** (1.0 / n)) * 100:.1f}%. "
      "This bounds the rate; it does not show the flake is gone.")
PY
  else
    echo "NOT CLEAN -- open the run files above. Do not rerun to green."
  fi
} >> "$OUT/SUMMARY.txt"

cat "$OUT/SUMMARY.txt"
exit 0
