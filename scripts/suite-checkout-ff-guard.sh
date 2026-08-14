#!/usr/bin/env bash
# suite-checkout-ff-guard.sh
#
# Keeps the SHARED marveen-suite checkout (~/marveen-suite) fast-forwarded to
# origin/main, so disk-based checks (e.g. the done-evidence-gate) stop false-
# alarming on cards whose deliverables were pushed via a throwaway worktree +
# direct push to origin/main (fullstackfejleszto's flow) -- the shared checkout
# would otherwise sit behind origin/main and "miss" genuinely-merged files.
# (Root cause flagged by fullstack 2026-07-07: c20f1964 false-alarm.)
#
# LOCAL-ONLY, UNTRACKED (.git/info/exclude of ~/marveen) -- no tracked/upstream
# file touched; official marveen `git pull` stays clean. Operates only on the
# SEPARATE ~/marveen-suite repo.
#
# SAFE BY CONSTRUCTION: fast-forwards ONLY when the shared checkout is
#   (a) on branch main, (b) working tree CLEAN, (c) strictly BEHIND origin/main,
#   (d) NOT ahead (no local unpushed commits).
# A pure ff under those conditions cannot conflict, merge, or lose work. If an
# agent is mid-edit (dirty) or has local commits (ahead), it SKIPS -- never
# stomps agent work in the shared checkout.
set -uo pipefail

SUITE="$HOME/marveen-suite"
[ -d "$SUITE/.git" ] || exit 0
cd "$SUITE" || exit 0

# only main
[ "$(git branch --show-current 2>/dev/null)" = "main" ] || { echo "skip: not on main"; exit 0; }
# clean tree
[ -z "$(git status --porcelain 2>/dev/null)" ] || { echo "skip: dirty tree (agent working)"; exit 0; }

git fetch -q origin 2>/dev/null || { echo "skip: fetch failed"; exit 0; }
behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)

if [ "${behind:-0}" -gt 0 ] && [ "${ahead:-0}" -eq 0 ]; then
    if git merge --ff-only origin/main >/dev/null 2>&1; then
        echo "ff: shared checkout advanced ${behind} commits -> $(git rev-parse --short HEAD)"
    else
        echo "warn: ff-only failed unexpectedly (left untouched)"
    fi
else
    echo "noop: behind=$behind ahead=$ahead (nothing safe to ff)"
fi
exit 0
