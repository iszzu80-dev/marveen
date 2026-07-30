#!/usr/bin/env bash
# sync-mcp-servers.sh — preserve the MCP server sources across a reinstall,
# WITHOUT tracking them in git.
#
# Card d95ac444. OWNER DECISION (Istvan, 2026-07-30): mcp-servers/ stays fully
# gitignored ("Vallaljuk, mert nem szeretnem, hogy barmikor idegen kezekbe
# kerüljön a belepesem"). Do NOT narrow that .gitignore rule — it removes an
# entire future error class: nobody can ever commit a token pasted into a
# server file, or a credential file dropped beside one.
#
# For the record, so the decision is not re-derived from a wrong premise: the
# credentials are NOT in mcp-servers/. They live in
# store/.google-private-creds.json (client_id / client_secret / refresh_token),
# separately gitignored (.gitignore:13), mode 600. The server sources only
# reference those FIELD NAMES. This script therefore copies CODE, never a
# secret — and it deliberately refuses to copy anything that looks otherwise
# (see the credential-shaped-content guard below).
#
# The accepted-but-real cost of that decision: every fix to an MCP server was
# lost on reinstall / fresh clone / new machine, and nothing preserved them.
# devops's SERVER_INFO fix (google-private-mcp.py, google-zst -> google-private)
# was disk-local only. This closes that gap the same way scripts/
# sync-scheduled-scripts.sh closed it for the scheduled-task deps: pin into the
# gitignored releases/ tree, which no `git checkout` can touch.
#
# Unlike sync-scheduled-scripts.sh, there is no `git show <ref>:<path>` option
# here — these files exist ONLY in the working tree by design, so the working
# tree IS the source of truth. A dirty edit in flight would land in the
# release, which is why --status records the exact bytes installed (sha256).
#
# Usage:
#   sync-mcp-servers.sh              install a new release + repoint 'current'
#   sync-mcp-servers.sh --status     show what 'current' holds (hashes)
#   sync-mcp-servers.sh --list       list installed releases
#   sync-mcp-servers.sh --restore    copy 'current' BACK into mcp-servers/
#                                    (the reinstall path; refuses to clobber
#                                    a newer working-tree file without --force)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASES_DIR="$REPO_ROOT/releases"
CURRENT_LINK="$RELEASES_DIR/mcp-servers-current"
SRC_DIR="$REPO_ROOT/mcp-servers"

die() { echo "ERROR: $*" >&2; exit 1; }

# Refuse to pin anything that carries a credential-shaped VALUE (not just the
# field name). A long base64/hex run after a secret-ish key, or a Google
# refresh-token / OAuth client-secret prefix. The point is that this script can
# never become the thing that copies a secret out of store/ into releases/.
CRED_VALUE_RE='(client_secret|refresh_token|access_token|api[_-]?key|password)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_./+-]{20,}'
GOOGLE_SECRET_RE='(1//[A-Za-z0-9_-]{30,}|GOCSPX-[A-Za-z0-9_-]{10,})'

sha() { sha256sum "$1" | cut -d' ' -f1; }

current_target() { [ -L "$CURRENT_LINK" ] && readlink "$CURRENT_LINK" || echo ""; }

if [ "${1:-}" = "--list" ]; then
  shopt -s nullglob
  found=0
  for d in "$RELEASES_DIR"/mcp-servers-*/; do
    [ -d "$d" ] || continue
    found=1
    echo "$(basename "$d")"
  done
  [ "$found" = 1 ] || echo "(no releases installed)"
  cur=$(current_target); [ -n "$cur" ] && echo "current → $cur"
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  cur=$(current_target)
  [ -n "$cur" ] || die "no 'current' release installed (run with no args first)"
  echo "current → $cur"
  for f in "$CURRENT_LINK"/*.py; do
    [ -f "$f" ] || continue
    printf '  %-28s %s\n' "$(basename "$f")" "$(sha "$f")"
  done
  # Report drift against the live working tree -- the whole point of recording
  # bytes is being able to answer "is what I pinned still what is running".
  echo "  --- drift vs $SRC_DIR ---"
  for f in "$CURRENT_LINK"/*.py; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    if [ ! -f "$SRC_DIR/$base" ]; then
      printf '  %-28s MISSING from the working tree\n' "$base"
    elif [ "$(sha "$f")" = "$(sha "$SRC_DIR/$base")" ]; then
      printf '  %-28s in sync\n' "$base"
    else
      printf '  %-28s DRIFTED (working tree differs from the pin)\n' "$base"
    fi
  done
  exit 0
fi

if [ "${1:-}" = "--restore" ]; then
  force="${2:-}"
  cur=$(current_target)
  [ -n "$cur" ] || die "no 'current' release to restore from"
  mkdir -p "$SRC_DIR"
  restored=0
  for f in "$CURRENT_LINK"/*.py; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    dest="$SRC_DIR/$base"
    if [ -f "$dest" ] && [ "$(sha "$f")" != "$(sha "$dest")" ] && [ "$force" != "--force" ]; then
      echo "SKIP $base: working-tree copy differs from the pin; pass --force to overwrite" >&2
      continue
    fi
    cp "$f" "$dest"
    chmod 700 "$dest"
    restored=$((restored + 1))
  done
  echo "restored $restored file(s) into $SRC_DIR"
  [ "$restored" -gt 0 ] || die "restored 0 files -- refusing to report success on a no-op"
  exit 0
fi

# ── install (default) ────────────────────────────────────────────────────────
[ -d "$SRC_DIR" ] || die "no $SRC_DIR on disk -- nothing to pin"

shopt -s nullglob
FILES=("$SRC_DIR"/*.py)
[ "${#FILES[@]}" -gt 0 ] || die "no *.py in $SRC_DIR -- refusing to install an empty release"

# Guard BEFORE copying: never pin a file carrying a credential-shaped value.
for f in "${FILES[@]}"; do
  if grep -qiE "$CRED_VALUE_RE" "$f" || grep -qE "$GOOGLE_SECRET_RE" "$f"; then
    die "$(basename "$f") looks like it contains a credential VALUE, not just a field name. Refusing to pin it. Move the secret into store/ (gitignored, mode 600) and re-run."
  fi
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$RELEASES_DIR/mcp-servers-$STAMP"
mkdir -p "$RELEASE_DIR"

MANIFEST_FILES=""
first=1
for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  cp "$f" "$RELEASE_DIR/$base"
  chmod 700 "$RELEASE_DIR/$base"
  [ "$first" = 1 ] && first=0 || MANIFEST_FILES="$MANIFEST_FILES,"
  MANIFEST_FILES="$MANIFEST_FILES\"$base sha256:$(sha "$f")\""
done

cat > "$RELEASE_DIR/release.json" <<EOF
{
  "releaseId": "mcp-servers-$STAMP",
  "source": "working-tree (mcp-servers/ is gitignored by owner decision, card d95ac444)",
  "installedAt": "$STAMP",
  "builtFrom": "scripts/sync-mcp-servers.sh",
  "files": [$MANIFEST_FILES]
}
EOF

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
echo "installed $RELEASE_DIR"
echo "current  → $(current_target)"
echo "files    : ${#FILES[@]}"
