#!/usr/bin/env bash
# Deploy one candidate sha as the pinned COS runtime, or refuse.
#
# WHY THIS FILE EXISTS. This twelve-step procedure was executed by hand three
# times on the night of 2026-08-26, read out of a document. On the third pass the
# runtime backup was named after the wrong sha (`dist.pre-086d6cf0d-` for a
# `07d82809f` runtime) -- an error a scripted procedure does not make, and one
# that only matters when you need the backup. The shape of the risk is the same
# one the whole pinned-release design exists to close: a step nobody can see
# skipped is indistinguishable from a step that ran.
#
# It deliberately does NOT decide whether a candidate is fit to release. It
# refuses on facts it can check (dirty tree, missing sha, gate drift) and leaves
# the judgement -- CI green on both events, suite green, owner GO -- to the human
# and the guard. Anything that JUDGES a release belongs in the guard, which is
# itself pinned.
#
# Usage:  cos-pinned-cutover.sh <candidateSha> [--gate-sha <sha>] [--dry-run]
#         The gate defaults to the candidate. It is a SEPARATE argument because
#         the gate is versioned independently of the payload: a gate can only
#         REFUSE, so carrying a stricter gate across a rollback can block a bad
#         release but never cause one. (Discovered by the W14 rollback drill: the
#         then-pinned runtime 0011de922 did not contain the guard at all.)
set -uo pipefail

REPO="${MARVEEN_REPO_ROOT:-$HOME/marveen}"
DRY=0; GATE=""
SHA="${1:-}"; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --gate-sha) GATE="${2:-}"; shift 2 ;;
    --dry-run)  DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { printf 'CUTOVER REFUSED: %s\n' "$1" >&2; exit 92; }
say() { printf '  %s\n' "$1"; }

[ -n "$SHA" ] || die "no candidate sha given"
SHA="$(git -C "$REPO" rev-parse --verify "$SHA^{commit}" 2>/dev/null)" || die "not a commit: $SHA"
GATE="${GATE:-$SHA}"
GATE="$(git -C "$REPO" rev-parse --verify "$GATE^{commit}" 2>/dev/null)" || die "gate sha is not a commit"
SHORT="${SHA:0:9}"; GSHORT="${GATE:0:9}"

# The release is built with `git archive`, which reads the OBJECT, not the
# worktree -- so a dirty tree cannot leak into the artifact. It can still leak
# into the dist/ build below, which is why this refuses rather than warns.
DIRTY="$(git -C "$REPO" status --porcelain | grep -v '^?? ' | head -5)"
[ -z "$DIRTY" ] || die "the checkout has uncommitted tracked changes; the dist build would carry them:
$DIRTY"

# The gate must EXIST at the gate sha. Silently deploying a payload whose gate
# cannot be built is how a rollback lands on no gate at all.
git -C "$REPO" show "$GATE:scripts/run-pinned-cos-cycle.sh" >/dev/null 2>&1 \
  || die "no scripts/run-pinned-cos-cycle.sh at gate sha $GSHORT -- this candidate would deploy WITHOUT a gate"

# THE FRONTEND IS PART OF THE RELEASE (owner ruling, 2026-09-03). Checked at the
# PAYLOAD sha and checked HERE, before a single byte is written: a candidate with
# no web/ would produce a runtime that can only serve a page from outside its own
# release identity, and that is the defect this whole change closes. The build
# refuses too; both refuse, because the build cannot see a candidate the cutover
# never extracts, and the cutover cannot see a copy the build never makes.
git -C "$REPO" ls-tree -d --name-only "$SHA" web >/dev/null 2>&1 \
  && [ -n "$(git -C "$REPO" ls-tree -d --name-only "$SHA" web)" ] \
  || die "candidate $SHORT ships no web/ -- the frontend is part of the release artifact and this candidate has none"
git -C "$REPO" cat-file -e "$SHA:web/coscontrol.js" 2>/dev/null \
  || die "candidate $SHORT has web/ but no web/coscontrol.js -- refusing to deploy a Mission Control with no control surface"

echo "cutover: payload $SHORT, gate $GSHORT$([ $DRY = 1 ] && echo ' (DRY RUN)')"

REL="$REPO/releases"
CYCLE="$REL/cos-cycle-$SHORT"
FEEDER="$REL/scheduled-scripts-$SHORT"
GUARD="$REL/guard-$GSHORT"
STAMP="$(date +%Y%m%dT%H%M%S)"

run() { if [ $DRY = 1 ]; then say "would: $*"; else eval "$@"; fi; }

# 1. Release artifacts: COPIES from the object store, not worktrees.
for spec in "$CYCLE:scripts src web package.json tsconfig.json" "$FEEDER:scripts/email-triage-fetch.py"; do
  dir="${spec%%:*}"; paths="${spec#*:}"
  # A release dir built BEFORE the frontend joined the artifact has no web/, and
  # reusing it would produce exactly the split this change removes. Reuse is only
  # safe when the artifact is complete, so an incomplete one is rebuilt rather
  # than trusted for being present.
  if [ -d "$dir" ] && [ "$dir" = "$CYCLE" ] && [ ! -d "$dir/web" ]; then
    say "release $(basename "$dir") predates frontend packaging (no web/) -- rebuilding it"
    run "rm -rf '$dir'"
  fi
  if [ -d "$dir" ]; then say "release exists, reusing: $(basename "$dir")"; else
    run "mkdir -p '$dir'"
    run "git -C '$REPO' archive '$SHA' $paths | tar -x -C '$dir'"
    say "built $(basename "$dir")"
  fi
done
run "printf '%s\n' '$SHA' > '$CYCLE/.release-sha'"
# PROVENANCE, not only content: two candidates can ship a byte-identical feeder.
run "printf '%s\n' '$SHA' > '$FEEDER/.release-sha'"
run "cp '$FEEDER/scripts/email-triage-fetch.py' '$FEEDER/email-triage-fetch.py'"

# 2. The release store is the LIVE database, by symlink. The guard re-checks this
#    by INODE, because a path can point anywhere.
[ -e "$CYCLE/store" ]        || # THE CONFIG IS PART OF THE RUNTIME, and it was not linked until now.
# `readEnvFile()` resolves .env from PROJECT_ROOT, which for a release artifact is
# the release directory itself -- and that directory has no .env. So the pinned
# cycle could never read SCHEDULER_TZ, and APP_TZ fell back to whatever timezone
# the HOST was in. It happened to be Europe/Budapest, which is why nothing looked
# wrong: the quiet-hours policy (22:00-07:00 Europe/Budapest) was holding by
# accident of the box rather than by decision. Owner release gate, 2026-09-04.
run "ln -s '$REPO/.env' '$CYCLE/.env'"
run "ln -s '$REPO/store' '$CYCLE/store'"
[ -e "$CYCLE/node_modules" ] || run "ln -s '$REPO/node_modules' '$CYCLE/node_modules'"

# 3. The gate, from the gate sha, as an artifact.
run "mkdir -p '$GUARD'"
run "git -C '$REPO' show '$GATE:scripts/run-pinned-cos-cycle.sh' > '$GUARD/run-pinned-cos-cycle.sh'"
run "chmod +x '$GUARD/run-pinned-cos-cycle.sh'"

# 5. The runtime build, with a backup NAMED AFTER WHAT IT ACTUALLY IS -- read from
#    the pin being replaced, never typed by hand. This is the step that went wrong
#    on 2026-08-26.
PREV_SHA="$(python3 -c "import json;print(json.load(open('$REL/dashboard-runtime-pin.json'))['activationCandidateSha'][:9])" 2>/dev/null || echo unknown)"
if [ -d "$REPO/dist" ]; then
  run "cp -a '$REPO/dist' '$REPO/dist.pre-$PREV_SHA-$STAMP'"
  say "runtime backup: dist.pre-$PREV_SHA-$STAMP (named from the pin it replaces)"
fi
# THE BUILD SOURCE IS THE ARTIFACT, NEVER THE SHARED CHECKOUT.
#
# This line used to be `cd $REPO && npm run build`. $REPO is the shared checkout,
# which sits on develop -- so on 2026-08-31 a clean cutover of a8c22955 produced a
# dist built from develop while this script's own pin declared a8c22955, and
# nothing could see it: run-pinned-cos-cycle.sh reads runtimeSha OUT OF THE PIN,
# so the readback compared the declaration to itself.
#
# build-release-dist.ts compiles inside releases/cos-cycle-<short>/ (extracted by
# `git archive` above), MEASURES that source tree against a fresh `git archive` of
# the same sha before compiling, and writes a provenance manifest into the dist
# from the bytes it produced. It exits 93 rather than build something it cannot
# vouch for.
if [ $DRY = 1 ]; then
  say "would: (cd '$CYCLE' && npx tsx scripts/build-release-dist.ts '$CYCLE' --expect-sha '$SHA')"
  say "would: install that dist as $REPO/dist (after provenance verification)"
else
  # THE RELEASE TOOLING COMES FROM THE RELEASE, exactly like the guard does.
  # Calling $REPO/scripts/build-release-dist.ts would have run the SHARED
  # checkout's copy -- the same class of mistake as building from the shared
  # checkout, one level up: a build script that moves with develop cannot vouch
  # for a pinned artifact. $CYCLE/scripts came out of `git archive $SHA` above.
  [ -f "$CYCLE/scripts/build-release-dist.ts" ] \
    || die "candidate $SHORT ships no scripts/build-release-dist.ts -- it predates build provenance and cannot be deployed by this cutover"
  ( cd "$CYCLE" && npx tsx scripts/build-release-dist.ts "$CYCLE" --expect-sha "$SHA" ) \
    || die "the release artifact did not build, or could not prove itself -- nothing installed, pin unchanged"

  # FAIL CLOSED BEFORE THE SWAP. The artifact must prove the exact candidate sha
  # while it is still only a directory; an unproven artifact never becomes dist.
  ( cd "$CYCLE" && npx tsx scripts/verify-runtime-provenance.ts --dist "$CYCLE/dist" --expect "$SHA" >/dev/null ) \
    || die "the built artifact does not prove $SHORT -- nothing installed, pin unchanged"

  run "rm -rf '$REPO/dist' && cp -a '$CYCLE/dist' '$REPO/dist'"
  say "installed dist from $CYCLE/dist (provenance-verified)"

  # And again on the DEPLOYED copy: cp is not proof that what landed is what was
  # verified.
  ( cd "$CYCLE" && npx tsx scripts/verify-runtime-provenance.ts --dist "$REPO/dist" --expect "$SHA" >/dev/null ) \
    || die "the INSTALLED dist does not prove $SHORT -- the copy did not land intact"
  say "deployed dist re-verified in place"
fi

# 5b. ONLY NOW do the pointers move.
#
# They used to move BEFORE the build, and a refusal after that point left
# `cos-cycle-current` aimed at a candidate the pin does not name -- which makes
# the guard's check 1 fail and stops the CoS cycle. That is the 2026-08-26
# incident shape, reached by a script whose whole purpose is to avoid it. Found
# on 2026-08-31 by running a candidate that ships no build tooling: the refusal
# was correct and the state it left behind was not.
#
# FAIL CLOSED HAS TO MEAN "NOTHING CHANGED", not "we stopped halfway". Every step
# that can refuse now runs while the pointers still aim at the outgoing release,
# so a refused cutover leaves a system that is exactly as it was.
for pair in "cos-cycle-current:$CYCLE" "scheduled-scripts-current:$FEEDER" "guard-current:$GUARD"; do
  run "rm -f '$REL/${pair%%:*}' && ln -s '${pair#*:}' '$REL/${pair%%:*}'"
done
say "pointers moved together (after the artifact proved itself)"

# 6. The pin: the single statement of what the gate IS. Both digests, computed
#    from the files just written -- neither script can verify itself.
if [ $DRY = 0 ]; then
  python3 - "$REPO" "$SHA" "$GATE" "$GSHORT" "$PREV_SHA" "$*" <<'PY'
import hashlib, json, os, subprocess, sys
repo, sha, gate, gshort, prev, note = sys.argv[1:7]
pinp = os.path.join(repo, 'releases', 'dashboard-runtime-pin.json')
old = json.load(open(pinp))
h = lambda p: hashlib.sha256(open(p,'rb').read()).hexdigest()
pin = {
 'note': old.get('note',''),
 'deployedAt': subprocess.check_output(['date','--iso-8601=seconds']).decode().strip(),
 'activationCandidateSha': sha,
 'gateSha': gate,
 'previousActivationCandidateSha': old.get('activationCandidateSha'),
 'previousRuntime': f'dist.pre-{prev}',
 'guardSha256': h(os.path.join(repo,'releases',f'guard-{gshort}','run-pinned-cos-cycle.sh')),
 'preflightSha256': h(os.path.join(repo,'scripts','cos-cycle-preflight.sh')),
 'ciEvidence': 'FILL IN: workflow, both events, run ids, at this exact sha',
 'rollbackProvenance': old.get('rollbackProvenance'),
}
json.dump(pin, open(pinp,'w'), indent=1)
print('  pin rewritten: guardSha256', pin['guardSha256'][:12], '| preflightSha256', pin['preflightSha256'][:12])
PY
fi

# 7. VERIFY BEFORE THE RESTART, not after. A gate checked only afterwards cannot
#    stop the thing it was meant to stop.
if [ $DRY = 0 ]; then
  bash "$REPO/scripts/cos-cycle-preflight.sh" --verify-only || die "the gate REFUSES the state this script just wrote -- nothing restarted"
  # The gate checks the pin against the release. This checks the RUNTIME against
  # the pin, measured from the deployed artifact -- the half the gate cannot do.
  ( cd "$CYCLE" && MARVEEN_REPO_ROOT="$REPO" npx tsx scripts/verify-runtime-provenance.ts --expect-from-pin ) \
    || die "the DEPLOYED runtime does not prove the sha the pin declares" 
  echo "cutover staged and gate-verified. Restart the runtime, then read the pin back."
else
  echo "dry run complete; nothing written."
fi
