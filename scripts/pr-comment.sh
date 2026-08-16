#!/usr/bin/env bash
# Post a PR comment AND record its id as mine, so the watcher never wakes me up
# about my own text.
#
# The watcher already suppresses comments whose body starts with "## Marveen",
# but that only works when I remember the heading — and on 2026-08-16 I did not,
# so my own PR #20 comment woke me up. A heading is a convention; an id is a
# fact. This wrapper records the fact.
#
# Usage: scripts/pr-comment.sh <pr-number> <body-file> [repo]
set -euo pipefail

PR="${1:?pr number required}"
BODY="${2:?body file required}"
REPO="${3:-iszzu80-dev/marveen-private}"
ROOT="${MARVEEN_REPO_ROOT:-$HOME/marveen}"
MINE="$ROOT/store/.pr-comment-mine.json"

url="$(gh pr comment "$PR" --repo "$REPO" --body-file "$BODY")"
echo "$url"

# The URL ends in #issuecomment-<id>; anything else means the API changed and we
# must NOT silently record nothing — an empty record would look like success.
id="${url##*#issuecomment-}"
if [[ ! "$id" =~ ^[0-9]+$ ]]; then
  echo "pr-comment.sh: cannot parse comment id from '$url' — NOT recorded as mine" >&2
  exit 1
fi

python3 - "$MINE" "$id" <<'PY'
import json, os, sys
path, cid = sys.argv[1], int(sys.argv[2])
ids = []
if os.path.exists(path):
    try: ids = json.load(open(path)).get('ids', [])
    except Exception: ids = []
if cid not in ids:
    ids.append(cid)
# Bounded: only recent ids matter, the watcher's own marker handles the rest.
json.dump({'ids': ids[-200:]}, open(path, 'w'))
print(f'recorded as mine: {cid}')
PY
