#!/usr/bin/env bash
# §14 personal-daily-reconcile. Deterministic: exit 0 = clean (silent),
# 1 = findings (the scheduler escalates), 2 = the reconcile itself broke.
# A crash must NOT read as a clean day, which is why 2 is separate from 0.
cd "$HOME/marveen" || exit 2
exec npx tsx scripts/cos-daily-reconcile.ts
