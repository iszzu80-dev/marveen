#!/usr/bin/env python3
# done-evidence-gate: verify file paths referenced in a done card's comments
# actually exist on disk before trusting the "done" status. No LLM.
#
# WHY (2026-07-01): two incidents same night (Atlas' bolcsi UI spec, Falcon's
# QA VERDICT.md) where an agent reported "kesz, fajl X mentve" but the file
# was never actually written (context ran out right at the save step). A
# card moved to done on that claim alone, and nobody noticed for hours.
#
# 2026-07-04 UPGRADE (Istvan): local-only evidence-gate improvements. Kept
# entirely OUTSIDE the tracked marveen repo (this script lives in
# ~/.claude/scheduled-tasks/, audit file in the gitignored store/) so it never
# diverges from the official Szotasz/marveen upstream. Deterministic, zero LLM.
#   A) reopen-to-waiting on genuine-missing evidence (kept) + assignee nudge.
#   B) durable move-audit log: who (assignee) + when + evidence result, since
#      the kanban_cards table has no "who moved it" column.
#   C) HARDENED resolver -- the investigation (2026-07-04) showed most apparent
#      "done but no file" is NOT lost work: cutover path-drift (marveen-legacy),
#      renamed/dated files (feature-tiers.md -> 2026-06-28-eskuvo-feature-tiers.md),
#      files outside the repo (~/.pg-qa, gitignored store/, the suite monorepo).
#      A basename-anywhere fallback treats those as "exists" to AVOID false
#      reopens; only genuinely-absent files reopen a card.
# 2026-07-30 UPGRADE (card bb5d8108): this is the CARD-reopening gate -- the
# other evidence gate (marveen/scripts/inter-agent-evidence-gate.py) only ever
# posts an inter-agent MESSAGE and never touches a card's status. Two false-
# positive classes were fixed THERE (cards 9682c5ee, dc0fb6f0) while THIS
# script, which is what actually flips a card back to waiting, had neither
# fix -- proven by the dc0fb6f0 reopen landing on this cron's own :10 slot,
# three minutes after the fix it was reopening had already merged. Ported both
# rules by REUSING the shipped, mutation-proven implementations (see
# _load_evidence_gate_helpers below) rather than re-deriving them here, so the
# two scripts cannot silently diverge on the same rule again.
#
# TEST: python3 ~/.claude/scheduled-tasks/done-evidence-gate/check.test.py
# (colocated, not repo-tracked -- run manually after any edit to this file.
# See check.test.py's own docstring for why it lives here instead.)
import sqlite3, time, subprocess, os, json, sys, re, glob

HOME = os.path.expanduser('~')
DB = os.path.join(HOME, 'marveen/store/claudeclaw.db')
ENV_FILE = os.path.join(HOME, '.claude/channels/telegram/.env')
DASH_TOKEN_FILE = os.path.join(HOME, 'marveen/store/.dashboard-token')
AUDIT_FILE = os.path.join(HOME, 'marveen/store/kanban-move-audit.jsonl')  # gitignored via store/
CHAT_ID = '8942301795'
WINDOW_SEC = 35 * 60

# Known project roots to resolve a relative path against, tried in order.
ROOTS = [
    os.path.join(HOME, 'marveen'),
    os.path.join(HOME, 'marveen-legacy-20260630-013023'),
    os.path.join(HOME, 'marveen-legacy-20260630-013023-final'),
    os.path.join(HOME, 'marveen-projects/dora'),
    os.path.join(HOME, '.pg-qa'),
    # Sidecar/standalone repos (2026-07-17: evidence-gate hardening)
    os.path.join(HOME, 'marveen-suite'),
    os.path.join(HOME, 'marveen-local/apg-kernel'),
]
# Directories to search a bare basename under (bounded), to catch renamed/dated
# or relocated deliverables so we do NOT false-reopen genuinely-done work.
BASENAME_SEARCH_GLOBS = [
    os.path.join(HOME, 'marveen/agents/*/deliverables/**/'),
    os.path.join(HOME, 'marveen/shared-dev/**/'),
    os.path.join(HOME, 'marveen/audits/'),
    os.path.join(HOME, 'marveen/store/'),
    os.path.join(HOME, 'marveen-legacy-20260630-013023/**/'),
    os.path.join(HOME, '.pg-qa/'),
    # Standalone product repos (dora-app etc.) live outside marveen/ -- include
    # them so their real files do not read as "missing" (multi-repo awareness).
    os.path.join(HOME, 'marveen-projects/**/'),
    # Sidecar repos (2026-07-17)
    os.path.join(HOME, 'marveen-suite/**/'),
    os.path.join(HOME, 'marveen-local/apg-kernel/**/'),
]

# Top-level dir segments that a LOCAL deliverable path starts with. If a cited
# path does not resolve AND its first segment is not one of these, the check is
# INCONCLUSIVE (likely a file in a standalone/remote repo not cloned here, or a
# bare filename mentioned in prose) -- we do NOT flag it missing. Genuinely-
# missing LOCAL deliverables always start with one of these.
LOCAL_VERIFIABLE_PREFIXES = (
    'scripts/', 'agents/', 'shared-dev/', 'audits/', 'store/',
    'deliverables/', 'seed-skills/', 'db/', 'migrations/',
)

# Only treat a token as a deliverable path if it ends in a REAL file extension.
# This is the single biggest false-positive killer: it stops the extractor from
# matching AC/requirement codes and versions (AC-5.4, Art.9, US-7.1-7.2, v1.2)
# that happen to look path-like.
FILE_EXTS = {'md', 'ts', 'tsx', 'js', 'mjs', 'cjs', 'sql', 'py', 'json', 'html',
             'css', 'yaml', 'yml', 'sh', 'txt', 'csv', 'xml', 'toml', 'env'}
PATH_RE = re.compile(r'(?<![\w/])((?:[\w.-]+/)+[\w.-]+\.[a-zA-Z0-9]{1,10})(?![\w/])')
# Path prefixes that live in the SEPARATE marveen-suite monorepo (iszzu80-dev/
# marveen-suite), not in any locally-searchable root. We can't verify these from
# here, so we do NOT flag them missing (avoids false-reopening active build cards).
SUITE_PREFIXES = ('apps/api/', 'apps/web/', 'packages/', 'db/migrations/')


def read_bot_token():
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if 'BOT_TOKEN' in line and '=' in line:
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return None


def dash_token():
    try:
        return open(DASH_TOKEN_FILE).read().strip()
    except Exception:
        return None


def resolve(path):
    """Return a real path if the cited file exists ANYWHERE plausible, else None.
    Hardened to avoid false-missing: checks roots, deliverables/shared-dev, and a
    bounded basename-anywhere fallback (renamed/dated/relocated deliverables)."""
    p = path.strip().strip('`').rstrip('.,;)')
    if '://' in p or p.startswith('//'):
        return None  # URL, not a file
    if p.startswith('/'):
        return p if os.path.exists(p) else None
    for root in ROOTS:
        if os.path.exists(os.path.join(root, p)):
            return os.path.join(root, p)
    # relative-to-deliverables / shared-dev
    for pattern in (
        os.path.join(HOME, 'marveen/agents/*/deliverables/' + p),
        os.path.join(HOME, 'marveen/shared-dev/' + p),
    ):
        hits = glob.glob(pattern)
        if hits:
            return hits[0]
    # basename-anywhere fallback: a same-named file elsewhere is strong evidence
    # the work exists (renamed/dated/relocated), so do NOT flag it missing.
    bn = os.path.basename(p)
    if len(bn) >= 6:  # avoid matching trivially-short names
        for g in BASENAME_SEARCH_GLOBS:
            if glob.glob(os.path.join(g, bn), recursive=True):
                return 'basename-match'
    return None


def extract_candidates(text):
    out = []
    for m in PATH_RE.finditer(text):
        tok = m.group(1)
        ext = tok.rsplit('.', 1)[-1].lower()
        if ext not in FILE_EXTS:
            continue  # not a real file extension -> AC code / version / ref, skip
        if '...' in tok:
            continue  # truncated/elided path in a comment, not resolvable
        # ephemeral recovery snapshots are transient by design; not real deliverables
        if '/recovery/' in tok or tok.startswith('store/recovery'):
            continue
        # separate suite monorepo -> not locally verifiable, don't judge it
        if any(tok.startswith(pre) or ('/' + pre) in tok for pre in SUITE_PREFIXES):
            continue
        out.append(tok)
    return out


def _flaggable(pp):
    """Only flag as MISSING a path that (a) does not resolve locally AND
    (b) has a local-repo top-level prefix so it SHOULD be verifiable here.
    Paths without a known local prefix (bare filenames, standalone-repo
    files) are INCONCLUSIVE, not missing. Hoisted to module level (was a
    closure inside the per-card loop) so it is independently testable."""
    q = pp.strip().strip('`').lstrip('./')
    if q.startswith(SUITE_PREFIXES):
        return False
    return q.startswith(LOCAL_VERIFIABLE_PREFIXES)


def _load_evidence_gate_helpers():
    """Card bb5d8108: reuse the shipped, mutation-proven implementations from
    marveen/scripts/inter-agent-evidence-gate.py (gitignored_paths, cards
    9682c5ee/dc0fb6f0) rather than re-deriving the same two rules here a
    second time -- that duplication is exactly how this class of bug shipped
    fixed-in-one-gate-and-not-the-other the first time.

    FAILS OPEN: if the import itself fails (repo moved, file renamed, syntax
    error in the sibling script), returns no-op stand-ins that exclude
    NOTHING -- a broken import must not silently blanket-excuse every path
    across an entire cron run.
    """
    try:
        import importlib.util
        path = os.path.join(HOME, 'marveen/scripts/inter-agent-evidence-gate.py')
        spec = importlib.util.spec_from_file_location('inter_agent_evidence_gate', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.gitignored_paths, mod.extract_absence_asserted_paths
    except Exception:
        return (lambda paths: set()), (lambda text: set())


_gitignored_paths, _extract_absence_asserted_paths = _load_evidence_gate_helpers()


def compute_missing(candidates, full_text):
    """The full missing-deliverable decision for one card: a candidate is
    MISSING only if it (1) does not resolve on disk, (2) has a locally-
    verifiable prefix, (3) is not gitignored (card dc0fb6f0's rule -- a
    gitignored path can never be a committed deliverable), and (4) its own
    clause does not assert its absence (card 9682c5ee's rule -- clause-scoped,
    so an absence word elsewhere in the card text must not excuse an
    unrelated/re-claimed genuinely-missing path)."""
    gitignored = _gitignored_paths(candidates)
    absence_asserted = _extract_absence_asserted_paths(full_text)
    return [
        p for p in candidates
        if resolve(p) is None and _flaggable(p) and p not in gitignored and p not in absence_asserted
    ]


def categorize_candidates(candidates, full_text):
    """Card d2d949c3: return a derived breakdown of candidates so the OK
    verdict string is BUILT FROM the data, never hardcoded alongside it.

    Returns dict with keys:
      verified: paths resolved on disk (genuinely checked)
      gitignored: paths structurally excluded (can never be a committed deliverable)
      absence_asserted: paths whose own clause asserts non-existence (contextually excused)
      skipped_nonlocal: paths without a local-verifiable prefix (not our business)
      missing: genuinely missing (local, not resolved, not excused)"""
    gitignored = _gitignored_paths(candidates)
    absence_asserted = _extract_absence_asserted_paths(full_text)

    verified, gitig, absent, skipped_nonlocal, missing = [], [], [], [], []
    for p in candidates:
        if resolve(p) is not None:
            verified.append(p)
        elif p in gitignored:
            gitig.append(p)
        elif p in absence_asserted:
            absent.append(p)
        elif not _flaggable(p):
            skipped_nonlocal.append(p)
        else:
            missing.append(p)

    return {
        'verified': verified,
        'gitignored': gitig,
        'absence_asserted': absent,
        'skipped_nonlocal': skipped_nonlocal,
        'missing': missing,
    }


def format_ok_comment(categorized):
    """Derive the OK evidence-check comment from categorized data (card d2d949c3).
    Every claim in the output is traceable to a specific category count -- no
    hardcoded assertion that can drift from the underlying data."""
    parts = []
    v = len(categorized['verified'])
    g = len(categorized['gitignored'])
    a = len(categorized['absence_asserted'])
    s = len(categorized['skipped_nonlocal'])

    if v:
        parts.append(f"{v} verified on disk")
    if g:
        parts.append(f"{g} structurally excluded (gitignore)")
    if a:
        parts.append(f"{a} absence-asserted (not checked)")
    if s:
        parts.append(f"{s} non-local (not verifiable here)")

    if not parts:
        # No candidates at all (shouldn't reach here -- caller guards)
        return "evidence-check: OK -- no verifiable paths referenced (done-evidence-gate)"

    detail = "; ".join(parts)
    # Include total count so the surface can't silently drop a category:
    # "OK -- 3 cited: 1 verified on disk; 2 structurally excluded (gitignore)"
    total = len(categorized['verified']) + len(categorized['gitignored']) + \
            len(categorized['absence_asserted']) + len(categorized['skipped_nonlocal'])
    return f"evidence-check: OK -- {total} cited: {detail} (done-evidence-gate)"


def audit(rec):
    try:
        with open(AUDIT_FILE, 'a') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except Exception:
        pass


def nudge_assignee(assignee, card_id, title, missing):
    """Inter-agent nudge so the owning agent fixes it while still in context."""
    tok = dash_token()
    if not tok or not assignee or assignee.lower() in ('marveen', 'istvan', ''):
        return
    content = (
        f"done-evidence-gate: a(z) {card_id[:8]} ({title[:50]}) kartyad done-ra ment, "
        f"de a hivatkozott deliverable(ek) nem talalhatok sehol: {', '.join(missing[:3])}. "
        "Vagy mentsd el a helyere, vagy javitsd a kartyan az utvonalat. A kartya waiting-re allt vissza."
    )
    try:
        subprocess.run(
            ['curl', '-s', '-X', 'POST', 'http://localhost:3420/api/messages',
             '-H', 'Content-Type: application/json',
             '-H', f'Authorization: Bearer {tok}',
             '-d', json.dumps({'from': 'marveen', 'to': assignee, 'content': content})],
            timeout=12, capture_output=True
        )
    except Exception:
        pass


def main():
    # 2026-07-30 (card bb5d8108): the DB-touching run loop is wrapped in this
    # function -- previously it was bare module-level code, which meant
    # merely IMPORTING this file (e.g. to test the pure functions above) would
    # immediately connect to the LIVE kanban DB and mutate real card status.
    # Guarded by `if __name__ == '__main__'` below; cron behavior unchanged.
    bot_token = read_bot_token()
    now = int(time.time())
    cutoff = now - WINDOW_SEC

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row

    # 2026-07-07 (deliverylead gate-integrity flag): a FLOOR GATE / FINAL GATE card
    # requires multiple INDEPENDENT sign-offs (e.g. business feature-completeness +
    # uxuidesigner graphics-parity). A path-existence check is NOT a sign-off, so
    # this gate must not stamp such a card "OK" (false-clear) nor reopen it -- those
    # cards are verified by deliverylead, not by file evidence. Skip them entirely.
    cards = db.execute(
        "SELECT id, title, assignee, updated_at FROM kanban_cards "
        "WHERE status='done' AND updated_at > ? AND archived_at IS NULL "
        "AND title NOT LIKE '%FLOOR GATE%' AND title NOT LIKE '%FINAL GATE%' "
        "ORDER BY updated_at DESC",
        (cutoff,)
    ).fetchall()

    for card in cards:
        already = db.execute(
            "SELECT id FROM kanban_comments WHERE card_id = ? AND content LIKE 'evidence-check:%' "
            "ORDER BY created_at DESC LIMIT 1",
            (card['id'],)
        ).fetchone()
        if already:
            continue

        comments = db.execute(
            "SELECT content FROM kanban_comments WHERE card_id = ? ORDER BY created_at DESC LIMIT 10",
            (card['id'],)
        ).fetchall()
        full_text = '\n'.join(c['content'] for c in comments)
        # Ignore http(s):// deploy URLs -- a live URL is proven by HTTP, not by
        # local path-existence; leaving them in caused false "missing" reopens
        # (e.g. suite-web-.../assets/index-<hash>.js flagged as a missing file).
        full_text = re.sub(r'https?://\S+', ' ', full_text)
        candidates = sorted(set(extract_candidates(full_text)))

        if not candidates:
            continue  # no path-like token -- not enough signal, skip silently

        # Card d2d949c3: categorize candidates so every claim in the verdict
        # is DERIVED from actual verification data, never hardcoded alongside it.
        # The old `found = [p for p in candidates if p not in missing]` mixed
        # genuinely-verified paths with gitignored/absence-asserted/non-local
        # ones and called them ALL "verified on disk" -- a false claim.
        cat = categorize_candidates(candidates, full_text)
        # Backward-compat: compute_missing still used by the audit record + MISSING
        # branch; categorize_candidates produces the same missing list independently.
        missing = cat['missing']

        # B) durable audit of the done-transition (who=assignee, when, evidence result)
        audit({
            'ts': now, 'card_id': card['id'], 'title': (card['title'] or '')[:120],
            'assignee': card['assignee'] or '', 'moved_done_at': card['updated_at'],
            'cited': len(candidates),
            'verified': len(cat['verified']),
            'gitignored': len(cat['gitignored']),
            'absence_asserted': len(cat['absence_asserted']),
            'skipped_nonlocal': len(cat['skipped_nonlocal']),
            'missing': missing[:8],
            'verdict': 'OK' if not missing else 'MISSING',
        })

        if not missing:
            comment = format_ok_comment(cat)
            db.execute(
                "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, 'marveen', ?, ?)",
                (card['id'], comment, now)
            )
            db.commit()
            continue

        # A) genuine-missing evidence: reopen to waiting, comment, alert Istvan, nudge owner.
        note = (
            "evidence-check: MISSING -- "
            f"{len(missing)}/{len(candidates)} referenced path(s) NOT found anywhere on disk: "
            + ", ".join(missing[:5])
            + (f" (+{len(missing) - 5} more)" if len(missing) > 5 else "")
            + ". Card automatically reopened to waiting -- verify and re-close manually."
        )
        db.execute(
            "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, 'marveen', ?, ?)",
            (card['id'], note, now)
        )
        db.execute(
            "UPDATE kanban_cards SET status = 'waiting', updated_at = ? WHERE id = ?",
            (now, card['id'])
        )
        db.commit()

        nudge_assignee(card['assignee'], card['id'], card['title'] or '', missing)

        # Route to deliverylead for TRIAGE instead of pinging Istvan directly.
        # This gate is a heuristic with a real false-positive rate (deploy URLs,
        # files in standalone repos not cloned locally, filenames mentioned in
        # prose). The assignee is already nudged + the card reopened; Istvan should
        # only hear about a GENUINELY missing deliverable after a human confirms it,
        # not the raw "done but does not exist" noise.
        _tok = dash_token()
        if _tok:
            title = (card['title'] or '')[:80]
            text = (f"[EVIDENCE GATE -- TRIAGE] '{title}' ({card['assignee'] or '?'}) done volt, de "
                    f"{len(missing)} hivatkozott fajl nem talalhato lokalisan: {', '.join(missing[:4])}. "
                    f"Visszaallitva waiting-re, {card['assignee'] or '?'} ertesitve. "
                    f"Ismert false-positive rate (standalone-repo/deploy-URL/proza) -- ellenorizd; "
                    f"CSAK ha tenylegesen hianyzo/nem-deployolt deliverable, eszkalald marveennek Istvanhoz. Kulonben zard le.")
            try:
                subprocess.run(
                    ['curl', '-s', '-X', 'POST', 'http://localhost:3420/api/messages',
                     '-H', f'Authorization: Bearer {_tok}',
                     '-H', 'Content-Type: application/json',
                     '-d', json.dumps({'from': 'marveen', 'to': 'deliverylead', 'content': text})],
                    timeout=15, capture_output=True
                )
            except Exception:
                pass

    db.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
