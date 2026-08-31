#!/usr/bin/env bash
# T5 TEST<->RUNTIME FILESYSTEM ISOLATION GATE
#
# Owner's rule (2026-08-31):
#   "A TEST MUST NOT MUTATE A REPO/STORE PATH THAT THE RUNNING / PRODUCTION
#    RUNTIME CAN READ AS REAL PERSISTENT STATE."
#
# This is the mechanical form of that rule. It arms an inotify watcher over the
# checkout's store/ for the WHOLE suite run and fails if any CREATE / DELETE /
# MOVED_FROM / MOVED_TO names a production-authoritative file.
#
# Why inotify and not a monkey-patched fs: several suites shell out (execSync,
# the pinned-cycle scripts, install-monitor.sh). A patched fs in the vitest
# worker sees none of those writes. The kernel sees all of them.
#
# THE LIST IS DERIVED, NOT COPIED. src/cos/backup.ts POLICY_FILES is the repo's
# own declaration of which store files a policy backup must capture because a
# restore needs them; that is the same set the runtime reads as authoritative.
# Three files that list has never classified are added by name below, with the
# owner's category for each. A hardcoded second copy of the list would drift.
#
# EXIT CODES
#   0  suite green AND no production-authoritative path was touched
#   1  the suite itself failed
#   92 the gate refused: a test mutated a production-authoritative path
#   93 the instrument is not trustworthy (the watcher missed its own canary)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO/.t5-gate}"
MODE="${2:-normal}"
mkdir -p "$OUT"
cd "$REPO" || exit 1

# ── NEGATIVE CONTROL ──────────────────────────────────────────────────────────
# `--plant-violation` plants a test that writes a production-authoritative path
# the way the real offenders did (a raw join to the checkout's store/, ignoring
# storePath()). A gate that has never been driven red is a gate nobody has shown
# to be a gate; this is how it gets shown, on demand, by anyone.
#
# The plant writes the REAL store/config-overrides.json, so its previous content
# is saved and restored here rather than by the test -- a plant that crashes must
# still not leave the checkout altered.
PLANT="$REPO/src/__tests__/t5-negative-control.plant.test.ts"
PLANT_TARGET="$REPO/store/config-overrides.json"
PLANT_BACKUP="$OUT/config-overrides.json.pre-plant"
cleanup_plant() {
  rm -f "$PLANT"
  if [ -f "$PLANT_BACKUP" ]; then cp "$PLANT_BACKUP" "$PLANT_TARGET"
  else rm -f "$PLANT_TARGET"; fi
}
if [ "$MODE" = "--plant-violation" ]; then
  [ -f "$PLANT_TARGET" ] && cp "$PLANT_TARGET" "$PLANT_BACKUP"
  cat > "$PLANT" <<'PLANTEOF'
import { describe, it, expect } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// NEGATIVE CONTROL for the T5 filesystem-isolation gate. Planted and removed by
// scripts/test-fs-isolation-gate.sh --plant-violation; it is not part of a
// normal run. It deliberately does what the rule forbids -- writes a
// production-authoritative store path by a raw join, bypassing storePath() --
// so the gate has to go red. If this run comes back GREEN, the gate is decorative.
describe('T5 NEGATIVE CONTROL (planted)', () => {
  it('writes the production config-overrides.json, which the gate must catch', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const target = join(repoRoot, 'store', 'config-overrides.json')
    writeFileSync(target, JSON.stringify({ T5_NEGATIVE_CONTROL: true }, null, 2) + '\n')
    expect(existsSync(target)).toBe(true)
  })
})
PLANTEOF
  trap cleanup_plant EXIT
  echo "MODE=NEGATIVE_CONTROL (violation planted)" >&2
fi

# ── the production-authoritative set, derived from the source declaration ──
mapfile -t POLICY < <(
  awk '/^export const POLICY_FILES/,/^\]/' src/cos/backup.ts \
    | grep -oE "'[A-Za-z0-9._-]+\.(json|jsonl)'" | tr -d "'" | sort -u
)
if [ "${#POLICY[@]}" -lt 5 ]; then
  echo "REFUSED(93): could not derive POLICY_FILES from src/cos/backup.ts (got ${#POLICY[@]})"
  exit 93
fi

# Files POLICY_FILES has never classified. backup.ts calls these "unclassified --
# a question for the operator"; the owner's T5 categories answer it for these three.
UNCLASSIFIED_AUTHORITATIVE=(
  'apg-scope-overrides.json'        # scope / policy override
  'apg-decision-idempotency.json'   # checkpoint / idempotency state
  'costops-subscriptions.json'      # runtime-read subscription state
)
GUARDED=("${POLICY[@]}" "${UNCLASSIFIED_AUTHORITATIVE[@]}")

{
  echo "repo=$REPO"
  echo "sha=$(git rev-parse HEAD)"
  echo "started=$(date -Is)"
  echo "mode=$MODE"
  echo "guarded_count=${#GUARDED[@]}"
  printf 'guarded=%s\n' "${GUARDED[@]}"
} > "$OUT/GATE.txt"

python3 scripts/fs-event-watch.py "$REPO/store" > "$OUT/events.log" 2>&1 &
WATCH=$!
trap 'kill "$WATCH" 2>/dev/null; [ "$MODE" = "--plant-violation" ] && cleanup_plant' EXIT
sleep 1

# ── instrument liveness: the watcher must see a write we KNOW we made ──
# A watcher that died on arming produces an empty log, and an empty log is
# indistinguishable from a clean run. This makes the difference observable.
CANARY="$REPO/store/.t5-watcher-canary"
: > "$CANARY"
sleep 1
rm -f "$CANARY"
sleep 1
if ! grep -q '\.t5-watcher-canary' "$OUT/events.log"; then
  echo "REFUSED(93): the watcher did not record its own canary -- the instrument is dead" | tee -a "$OUT/GATE.txt"
  exit 93
fi
echo "instrument=LIVE (canary observed)" >> "$OUT/GATE.txt"

timeout 3600 npx vitest run > "$OUT/suite.txt" 2>&1
SUITE_RC=$?
sleep 2
kill "$WATCH" 2>/dev/null
trap - EXIT
[ "$MODE" = "--plant-violation" ] && cleanup_plant

grep -E '^ *Tests +|^ *Test Files +' "$OUT/suite.txt" | tail -2 >> "$OUT/GATE.txt"
echo "suite_rc=$SUITE_RC" >> "$OUT/GATE.txt"

# ── the verdict ──
# Match on the event's FILENAME field only, and include the atomic-write
# temporaries (<name>.<pid>.<n>.<rand>.tmp) and .bak siblings: those land in the
# same directory and a rename over the real file is exactly the mutation at issue.
: > "$OUT/VIOLATIONS.log"
for f in "${GUARDED[@]}"; do
  awk -v n="$f" 'NF>4 && ($5==n || index($5, n".")==1)' "$OUT/events.log" >> "$OUT/VIOLATIONS.log"
done

TOTAL=$(grep -c . "$OUT/events.log")
VIOL=$(grep -c . "$OUT/VIOLATIONS.log")
{
  echo "fs_events_total=$TOTAL"
  echo "violations=$VIOL"
  echo "finished=$(date -Is)"
} >> "$OUT/GATE.txt"

if [ "$VIOL" -ne 0 ]; then
  echo "REFUSED(92): $VIOL mutation(s) of production-authoritative store paths" | tee -a "$OUT/GATE.txt"
  sort -k5 "$OUT/VIOLATIONS.log" | awk '{print $5}' | sort | uniq -c | sort -rn | tee -a "$OUT/GATE.txt"
  exit 92
fi

if [ "$SUITE_RC" -ne 0 ]; then
  echo "SUITE FAILED (rc=$SUITE_RC) -- the isolation gate passed, the suite did not" | tee -a "$OUT/GATE.txt"
  exit 1
fi

echo "GATE PASS: suite green, 0 mutations on ${#GUARDED[@]} production-authoritative paths" | tee -a "$OUT/GATE.txt"
exit 0
