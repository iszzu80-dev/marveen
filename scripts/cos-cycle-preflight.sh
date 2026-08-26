#!/usr/bin/env bash
# PREFLIGHT: verify the release guard is the PINNED artifact, then exec it.
#
# WHY THIS EXISTS (owner's Phase 0 closure decision, 2026-08-26):
#   "A guard maga ne mozgó develop kódból fusson; legyen pinned/immutable
#    artifact, amelynek integritását a guardon kívüli egyszerű mechanizmus
#    ellenőrzi."
#
# The problem it closes: every consumer the guard polices is pinned to an exact
# sha, but the guard itself was executed from $REPO/scripts/, i.e. from the live
# checkout sitting on `develop`. The policeman moved whenever develop moved --
# including at the merge that PRECEDES a cutover. That is not a hole in the pin
# (a guard can only ever refuse), but "the whole chain is pinned" was false.
#
# WHAT THIS IS, AND WHAT IT IS NOT. This file is deliberately tiny and does
# exactly one thing: hash the guard artifact, compare it to the digest recorded
# in the pin, refuse or exec. It is the "simple mechanism outside the guard".
# It cannot verify ITSELF -- nothing can -- so the guard verifies this file in
# turn (its check 5), and both digests live in the pin. A closed circle whose
# boundary is write access to the repository, not an infinite chain of trust.
#
# Anything more than a hash-and-exec belongs in the guard, where it is pinned.
set -uo pipefail

REPO="${MARVEEN_REPO_ROOT:-$HOME/marveen}"
RUNTIME_PIN="$REPO/releases/dashboard-runtime-pin.json"
GUARD="$REPO/releases/guard-current/run-pinned-cos-cycle.sh"

fail() { printf '{"preflight":"REFUSED","reason":%s}\n' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >&2; exit 91; }

[ -f "$GUARD" ] || fail "no pinned guard artifact at $GUARD"

WANT="$(python3 -c "import json,sys; print(json.load(open('$RUNTIME_PIN'))['guardSha256'])" 2>/dev/null || true)"
[ -n "$WANT" ] || fail "the pin records no guardSha256; an unpinned guard is the condition this preflight exists to refuse"

HAVE="$(sha256sum "$GUARD" 2>/dev/null | cut -d' ' -f1)"
[ "$WANT" = "$HAVE" ] || fail "guard artifact does not match the pin (want ${WANT:0:12}, have ${HAVE:0:12}); refusing to run an unverified release gate"

printf '{"preflight":"OK","guardSha256":"%s"}\n' "${HAVE:0:16}" >&2
exec bash "$GUARD" "$@"
