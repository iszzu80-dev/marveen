#!/usr/bin/env python3
"""
inter-agent-evidence-gate.py — LLM-MENTES evidence verifier for inter-agent
completion claims.

Complements the done-evidence-gate (which checks kanban card status=done).
This gate monitors the agent_messages table for completion-claim patterns
(kész, done, elkészült, COMPLETE, etc.) and verifies that referenced file
paths actually exist on disk.

Missing evidence → kanban comment on linked card + Telegram alert to Istvan.
NO auto-prompt / auto-message to the claiming agent — human/PM decision.

Usage:
  python3 scripts/inter-agent-evidence-gate.py              # incremental (since last marker)
  python3 scripts/inter-agent-evidence-gate.py --all         # check all messages (for seeding)
  python3 scripts/inter-agent-evidence-gate.py --id <N>      # check specific message
  python3 scripts/inter-agent-evidence-gate.py --dry-run     # no-op, just print what would happen
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
STORE_DIR = REPO_ROOT / "store"
DB_PATH = STORE_DIR / "claudeclaw.db"
TOKEN_FILE = STORE_DIR / ".dashboard-token"
DASH_URL = os.environ.get("DASH_URL", "http://localhost:3420")
MARKER_FILE = STORE_DIR / "recovery" / "inter-agent-evidence-gate-marker.json"

# Known project roots for path resolution
LEGACY_ROOT = Path(os.path.expanduser("~/marveen-legacy-20260630-013023"))
# CANONICAL suite repo (origin main). 2026-07-07 fix: SUITE_ROOT previously
# pointed at agents/fullstackfejleszto/deliverables/suite -- a STALE local clone
# stuck on branch feat/qq-photo-upload-ui with uncommitted changes, so mainline
# files (e.g. packages/core/src/mk/kata-calc.ts) never resolved -> false-missing
# evidence + wrong card reopens (7c3af342 MK KATA v2). Point at the real repo.
SUITE_ROOT = Path(os.path.expanduser("~/marveen-suite"))
SUITE_DELIVERABLES_ROOT = REPO_ROOT / "agents" / "fullstackfejleszto" / "deliverables" / "suite"  # stale clone, kept only as a fallback

APG_KERNEL_ROOT = Path(os.path.expanduser("~/marveen-local/apg-kernel"))

PROJECT_ROOTS = [
    REPO_ROOT,
    LEGACY_ROOT,
    SUITE_ROOT,
    APG_KERNEL_ROOT,
    SUITE_DELIVERABLES_ROOT,
]

# Allow runtime extension via env var (colon-separated paths).
# EVIDENCE_GATE_EXTRA_ROOTS="~/my-other-repo:~/some-third-repo"
_extra_raw = os.environ.get("EVIDENCE_GATE_EXTRA_ROOTS", "")
for _p in _extra_raw.split(":"):
    _p = _p.strip()
    if _p:
        PROJECT_ROOTS.append(Path(os.path.expanduser(_p)))

# --- Regex patterns ---

# Completion-claim patterns -- case-insensitive.
# Match STRONG completion signals: sentence-final DONE/KESZ, explicit
# phase/milestone completion, deliverable claims. Avoid casual "done" as
# adjective ("what needs to be done", "have you done X?").
COMPLETION_RE = re.compile(
    r'(?:'
    # Hungarian: "X KESZ" / "X KÉSZ" at end of line or before punctuation
    r'K[EÉ]SZ[!.]?\s*$|'
    r'K[EÉ]SZ:\s|'
    r'\bKARTYA\s*K[EÉ]SZ|'
    r'\belk[eé]sz[üu]lt\s*(?:[:!.]|$)|'
    # English: "X DONE" / "X COMPLETE" at end of line or sentence
    r'\b(?:--\s*)?DONE\s*(?:[:!.]|$)|'
    r'\bCOMPLETE[D]?\s*(?:[:!.]|$)|'
    r'\b(?:Phase\s+\d+|Milestone)\s+(?:DONE|COMPLETE|K[EÉ]SZ)|'
    # Explicit deliverable: "delivered X"
    r'\bdelivered\s+\S+'
    r')',
    re.IGNORECASE | re.MULTILINE
)

# File-path patterns -- paths that look like deliverables
# Matches: scripts/foo.sh, agents/x/deliverables/y, db/migrations/z.sql, etc.
# Uses word-boundary or line-start anchoring to avoid mid-word matches.
_PATH_DIRS = (
    r"scripts|"
    r"agents/\S+/deliverables|"
    r"agents/\S+|"
    r"deliverables|"
    r"db/migrations|"
    r"store|"
    r"apps/\S+|"
    r"packages/\S+|"
    r"seed-skills/\S+"
)
_PATH_EXTS = r"(?:sh|py|tsx?|jsx?|sql|md|html?|css|json|ya?ml|txt|mjs)"

# Match relative deliverable paths with known extensions
PATH_RE = re.compile(
    r"(?<!\w)(?:" + _PATH_DIRS + r")/[^\s,;:)\]>]*\." + _PATH_EXTS + r"\b",
    re.IGNORECASE
)

# Also match paths without extensions but with clear structure (multi-segment)
PATH_NOEXT_RE = re.compile(
    r"(?<!\w)(?:" + _PATH_DIRS + r")/[^\s,;:)\]>]+(?:/[^\s,;:)\]>]+)+",
    re.IGNORECASE
)

# Files that are NOT deliverables (config/infra noise)
_NON_DELIVERABLE = {
    "claude.md", "soul.md", "dream.md", "readme.md",
    ".gitignore", ".env", ".env.example", "package.json",
    "tsconfig.json", "agent-config.json", ".mcp.json",
    "skill.md",
}


def _is_deliverable_path(raw_path):
    """Filter out known non-deliverable filenames and template placeholders."""
    basename = os.path.basename(raw_path).lower()
    if basename in _NON_DELIVERABLE:
        return False
    # Reject template placeholders like store/recovery/<agent>/<timestamp>
    if '<' in raw_path or '>' in raw_path:
        return False
    return True

# Absolute path patterns under known roots
ABS_PATH_RE = re.compile(
    r"/home/\S+/marveen[^\s,;:)\]>]*\." + _PATH_EXTS + r"\b",
    re.IGNORECASE
)

# Kanban card references: #<hex8> or #<seq>
HEX8_REF_RE = re.compile(r'#([a-f0-9]{8})\b', re.IGNORECASE)
SEQ_REF_RE = re.compile(r'#(\d{1,4})\b')
# Also: "kanban <hex8>" or "card <hex8>"
KANBAN_WORD_RE = re.compile(r'(?:kanban|card|k[aá]rtya)\s+(?:#\s*)?([a-f0-9]{8})', re.IGNORECASE)


def load_token():
    """Load dashboard API token."""
    try:
        return TOKEN_FILE.read_text().strip()
    except Exception:
        return ""


def load_marker():
    """Load the last-processed message ID marker."""
    try:
        if MARKER_FILE.exists():
            data = json.loads(MARKER_FILE.read_text())
            return data.get("last_processed_id", 0)
    except Exception:
        pass
    return 0


def save_marker(last_id):
    """Save the last-processed message ID marker."""
    MARKER_FILE.parent.mkdir(parents=True, exist_ok=True)
    MARKER_FILE.write_text(json.dumps({
        "last_processed_id": last_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, indent=2))


def fetch_unprocessed_messages(db, since_id=0, specific_id=None):
    """Fetch agent_messages that haven't been evidence-checked yet."""
    if specific_id:
        rows = db.execute(
            "SELECT id, from_agent, to_agent, content, status, created_at "
            "FROM agent_messages WHERE id = ?",
            (specific_id,)
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT id, from_agent, to_agent, content, status, created_at "
            "FROM agent_messages WHERE id > ? "
            "ORDER BY id ASC",
            (since_id,)
        ).fetchall()
    return rows


def has_completion_claim(content):
    """Check if the message contains a completion-claim pattern."""
    if not content:
        return False
    return bool(COMPLETION_RE.search(content))


def extract_file_paths(content):
    """Extract all file-path-like tokens from the message content."""
    paths = set()

    # Strip http(s):// URLs BEFORE path extraction. A live deploy URL
    # (e.g. suite-web-08wb.onrender.com/assets/index-<hash>.js) is a
    # live-artifact reference, NOT a local filesystem path -- leaving it in
    # causes false "missing" alerts. Deploy URLs are proven by HTTP, not by
    # path-existence, so we do not path-check them here.
    if content:
        content = re.sub(r'https?://\S+', ' ', content)

    # Relative paths with extensions
    for m in PATH_RE.finditer(content):
        p = m.group(0).strip().lstrip('-').strip()
        while p and p[0] in '- \t*':
            p = p[1:].strip()
        if p and _is_deliverable_path(p):
            paths.add(p)

    # Relative paths without extensions (multi-segment: dir/subdir/...)
    for m in PATH_NOEXT_RE.finditer(content):
        p = m.group(0).strip().lstrip('-').strip()
        while p and p[0] in '- \t*':
            p = p[1:].strip()
        if p and _is_deliverable_path(p):
            paths.add(p)

    # Absolute paths
    for m in ABS_PATH_RE.finditer(content):
        p = m.group(0).strip()
        if p:
            paths.add(p)

    return list(paths)


def resolve_path(raw_path):
    """Resolve a file path against known project roots. Returns resolved path or None."""
    p = Path(raw_path)

    # If it's absolute and exists, return it
    if p.is_absolute():
        return str(p) if p.exists() else None

    # Try against each project root
    for root in PROJECT_ROOTS:
        candidate = root / p
        if candidate.exists():
            return str(candidate)

    # Also try the raw path from cwd
    if Path(raw_path).exists():
        return str(Path(raw_path).resolve())

    return None


def extract_kanban_refs(content):
    """Extract kanban card references from message content.
    Returns list of (ref_string, card_id_or_None)."""
    refs = []

    # Hex8 references
    for m in HEX8_REF_RE.finditer(content):
        refs.append(('hex8', m.group(1).lower()))

    # "kanban/card/kartya <hex8>"
    for m in KANBAN_WORD_RE.finditer(content):
        hex_val = m.group(1).lower()
        if ('hex8', hex_val) not in refs:
            refs.append(('hex8', hex_val))

    return refs


def lookup_kanban_card(db, ref_value):
    """Look up a kanban card by hex8 prefix or seq number."""
    # Try hex8 prefix match
    rows = db.execute(
        "SELECT id, title, status FROM kanban_cards WHERE id LIKE ?",
        (f"{ref_value}%",)
    ).fetchall()
    if rows:
        return rows[0]

    # Try seq match (convert seq to id prefix)
    try:
        seq = int(ref_value)
        # Look up by rowid or sort order
        rows = db.execute(
            "SELECT id, title, status FROM kanban_cards ORDER BY sort_order ASC, created_at ASC"
        ).fetchall()
        # seq-1 because seq numbers start at 1 (or we need to find by some mapping)
        # Actually, kanban_ref_normalize uses seq_lookup which maps id_prefix -> seq
        # Reverse lookup: find the seq-th card
        if 0 <= seq - 1 < len(rows):
            return rows[seq - 1]
    except ValueError:
        pass

    return None


def post_kanban_comment(card_id, author, content, token):
    """Post a comment to a kanban card via the dashboard API."""
    payload = json.dumps({
        "card_id": card_id,
        "author": author,
        "content": content,
    })
    try:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST", f"{DASH_URL}/api/kanban/comments",
             "-H", "Authorization", f"Bearer {token}",
             "-H", "Content-Type", "application/json",
             "-d", payload],
            capture_output=True, text=True, timeout=10
        )
        return result.returncode == 0 and "error" not in result.stdout.lower()
    except Exception:
        return False


def post_daily_log(content, token):
    """Post to the daily log via the dashboard API."""
    payload = json.dumps({
        "agent_id": "buildfejleszto",
        "content": content,
    })
    try:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST", f"{DASH_URL}/api/daily-log",
             "-H", "Authorization", f"Bearer {token}",
             "-H", "Content-Type", "application/json",
             "-d", payload],
            capture_output=True, text=True, timeout=10
        )
        return result.returncode == 0
    except Exception:
        return False


def send_telegram_alert(content, token):
    """Route the evidence-gate finding to deliverylead for TRIAGE (not straight
    to Istvan). This gate is a heuristic with a real false-positive rate
    (deploy URLs, files that live in standalone repos not cloned locally,
    filenames merely mentioned in prose). Istvan should only hear about a
    GENUINELY missing deliverable after a human/agent confirms it -- otherwise
    he gets 'done but does not exist' noise. deliverylead triages + escalates."""
    payload = json.dumps({
        "from": "buildfejleszto",
        "to": "deliverylead",
        "content": f"[EVIDENCE GATE -- TRIAGE] {content}\n\nAutomatikus heurisztika, ismert false-positive rate (deploy-URL / standalone-repo path / prozaban emlitett fajlnev). Ellenorizd elesben; CSAK ha tenylegesen hianyzo/nem-deployolt deliverable, eszkalald marveennek. Kulonben zard le, ne menjen Istvanhoz.",
    })
    try:
        result = subprocess.run(
            ["curl", "-s", "-X", "POST", f"{DASH_URL}/api/messages",
             "-H", "Authorization", f"Bearer {token}",
             "-H", "Content-Type", "application/json",
             "-d", payload],
            capture_output=True, text=True, timeout=10
        )
        return result.returncode == 0
    except Exception:
        return False


def check_message(db, row, token, dry_run=False):
    """
    Check a single agent_messages row for completion claims with missing evidence.
    Returns a dict with findings or None if nothing to report.
    """
    msg_id, from_agent, to_agent, content, status, created_at = row

    if not has_completion_claim(content):
        return None

    paths = extract_file_paths(content)
    if not paths:
        return None  # completion claim but no file paths to verify

    # Resolve and check each path
    missing = []
    found = []
    for p in paths:
        resolved = resolve_path(p)
        if resolved:
            found.append((p, resolved))
        else:
            missing.append(p)

    # Only flag if there are completion claims AND missing files
    if not missing:
        # All paths exist — this is fine, nothing to flag
        # But we could log this as a PASS for auditing
        return {
            "msg_id": msg_id,
            "from_agent": from_agent,
            "to_agent": to_agent,
            "content_snippet": content[:200],
            "created_at": created_at,
            "verdict": "PASS",
            "paths_found": found,
            "paths_missing": [],
            "kanban_refs": [],
        }

    # Extract kanban refs
    kanban_refs = extract_kanban_refs(content)
    linked_cards = []
    for ref_type, ref_value in kanban_refs:
        card = lookup_kanban_card(db, ref_value)
        if card:
            linked_cards.append({
                "card_id": card[0],
                "title": card[1],
                "status": card[2],
                "ref": f"{ref_type}:{ref_value}",
            })

    return {
        "msg_id": msg_id,
        "from_agent": from_agent,
        "to_agent": to_agent,
        "content_snippet": content[:200],
        "created_at": created_at,
        "verdict": "MISSING",
        "paths_found": found,
        "paths_missing": missing,
        "kanban_refs": linked_cards,
    }


def format_comment(finding):
    """Format a kanban comment for a missing-evidence finding."""
    lines = [
        "evidence-check: MISSING",
        "",
        f"Message #{finding['msg_id']} from {finding['from_agent']} to {finding['to_agent']}:",
        f"> {finding['content_snippet'][:150]}",
        "",
        f"Missing path(s) ({len(finding['paths_missing'])}):",
    ]
    for p in finding["paths_missing"]:
        lines.append(f"  - {p}")
    if finding["paths_found"]:
        lines.append(f"")
        lines.append(f"Verified path(s) ({len(finding['paths_found'])}):")
        for p, resolved in finding["paths_found"]:
            lines.append(f"  + {p} -> {resolved}")
    return "\n".join(lines)


def format_alert(finding):
    """Format a Telegram alert for a missing-evidence finding."""
    lines = [
        "INTER-AGENT EVIDENCE GATE: Missing file(s) in completion claim",
        "",
        f"Agent: {finding['from_agent']} -> {finding['to_agent']} (msg #{finding['msg_id']})",
        f"Claim: {finding['content_snippet'][:150]}",
        "",
        f"MISSING ({len(finding['paths_missing'])}):",
    ]
    for p in finding["paths_missing"]:
        lines.append(f"  - {p}")
    if finding["kanban_refs"]:
        lines.append(f"Linked card(s): {', '.join(c['ref'] for c in finding['kanban_refs'])}")
    return "\n".join(lines)


def main():
    dry_run = "--dry-run" in sys.argv
    check_all = "--all" in sys.argv
    specific_id = None

    for i, arg in enumerate(sys.argv):
        if arg == "--id" and i + 1 < len(sys.argv):
            specific_id = int(sys.argv[i + 1])
            break

    if not DB_PATH.exists():
        print(f"ERROR: database not found at {DB_PATH}", file=sys.stderr)
        return 1

    db = sqlite3.connect(str(DB_PATH))
    token = load_token()

    if not token:
        print("WARNING: no dashboard token found, kanban comments disabled", file=sys.stderr)

    # Determine which messages to check
    if specific_id:
        rows = fetch_unprocessed_messages(db, specific_id=specific_id)
        print(f"Checking specific message #{specific_id}")
    elif check_all:
        rows = fetch_unprocessed_messages(db, since_id=0)
        print(f"Checking ALL {len(rows)} messages (--all mode)")
    else:
        last_id = load_marker()
        rows = fetch_unprocessed_messages(db, since_id=last_id)
        print(f"Checking {len(rows)} new messages (since id {last_id})")

    findings = []
    max_processed_id = load_marker() if not check_all and not specific_id else 0

    for row in rows:
        msg_id = row[0]

        try:
            finding = check_message(db, row, token, dry_run=dry_run)
        except Exception as e:
            print(f"  ERROR checking msg #{msg_id}: {e}", file=sys.stderr)
            max_processed_id = max(max_processed_id, msg_id)
            continue

        if finding is None:
            max_processed_id = max(max_processed_id, msg_id)
            continue

        if finding["verdict"] == "MISSING":
            findings.append(finding)
            verdict = "MISSING"
        else:
            verdict = "PASS"

        print(f"  msg #{msg_id}: {verdict} "
              f"(paths: +{len(finding['paths_found'])}/-{len(finding['paths_missing'])}, "
              f"cards: {len(finding['kanban_refs'])})")

        max_processed_id = max(max_processed_id, msg_id)

    # --- Act on MISSING findings ---
    if findings:
        print(f"\n{len(findings)} finding(s) with MISSING evidence:")

        for finding in findings:
            print(f"\n  msg #{finding['msg_id']} from {finding['from_agent']}:")
            for p in finding["paths_missing"]:
                print(f"    MISSING: {p}")

            if dry_run:
                print("    (dry-run: no action taken)")
                continue

            # Post comment on linked kanban cards
            if finding["kanban_refs"] and token:
                for card in finding["kanban_refs"]:
                    comment = format_comment(finding)
                    ok = post_kanban_comment(card["card_id"], "buildfejleszto", comment, token)
                    if ok:
                        print(f"    -> Comment posted on card {card['ref']} ({card['card_id'][:8]})")
                    else:
                        print(f"    -> FAILED to post comment on card {card['ref']}")

            # If no card ref, post to daily log
            if not finding["kanban_refs"] and token:
                log_content = f"## evidence-check: MISSING\n\n{format_comment(finding)}"
                post_daily_log(log_content, token)
                print(f"    -> Logged to daily log (no card ref)")

            # Send Telegram alert
            if token:
                alert = format_alert(finding)
                send_telegram_alert(alert, token)
                print(f"    -> Telegram alert sent via marveen")

        # Save marker (only in incremental mode)
        if not check_all and not specific_id and not dry_run:
            save_marker(max_processed_id)
            print(f"\nMarker updated: last_processed_id = {max_processed_id}")
    else:
        print("\nAll clear — no missing evidence found.")

        # Save marker even if nothing found (advance past checked messages)
        if not check_all and not specific_id and not dry_run and max_processed_id > 0:
            save_marker(max_processed_id)
            print(f"Marker updated: last_processed_id = {max_processed_id}")

    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
