#!/usr/bin/env python3
"""Stage 2H — RETROSPECTIVE_RETRIAGE safety sweep (shadow, no effect).

This is NOT a historical replay and it proves nothing about whether an old
decision was wrong: the judgement that produced (or withheld) those cases was
never recorded, so there is no ground truth to score against. The only question
asked here is forward-looking:

    "Under TODAY's triage rules, is there a thread among the case-less ones that
     should be surfaced now as a missed-case candidate?"

Read-only by construction: it opens the production SQLite `mode=ro`, calls only
Gmail search/read, and writes exactly one artifact outside the repository. It
counts the production tables before and after and fails the run if any moved.

Input semantics (Istvan, 2026-08-17):
  * the provider's own snippet is fetched read-only; it is NEVER reconstructed
    from the full body, because a rebuilt snippet is a different input and would
    quietly make the sweep incomparable with production;
  * a thread whose production-shaped input cannot be reproduced is reported as
    RETRIAGE_INPUT_NOT_EQUIVALENT and kept out of the equivalent results.

Usage:
  python3 scripts/cos-retrospective-retriage.py \
    --corpus /secure/cos-replay/source-2026-08-16.json \
    --out    /secure/cos-replay/retrospective-retriage.json
"""
from __future__ import annotations
import argparse, datetime as dt, hashlib, importlib.util, json, os, sqlite3, stat, sys, tempfile
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("MARVEEN_REPO_ROOT") or os.path.dirname(HERE)
DB = os.path.join(REPO, "store", "claudeclaw.db")

# The production triage feeder: its noise filter and its candidate shape ARE the
# deterministic half of the rules. Importing it (rather than restating it) is the
# only way the sweep can claim to run "today's rules" without becoming a second
# definition of them.
_spec = importlib.util.spec_from_file_location(
    "email_triage_fetch", os.path.join(HERE, "email-triage-fetch.py"))
FEED = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(FEED)

SAFETY_TABLES = (
    "personal_cases", "zst_cases", "email_processing", "zst_email_processing",
    "cos_triage_provenance", "outbound_ledger", "zst_outbound_ledger",
    "personal_case_events", "zst_case_events", "cos_documents",
)


def _ro_db() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def safety_counts() -> dict[str, int | None]:
    out: dict[str, int | None] = {}
    con = _ro_db()
    try:
        for t in SAFETY_TABLES:
            try:
                out[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            except sqlite3.Error:
                out[t] = None  # table absent: recorded as absent, not as zero
    finally:
        con.close()
    return out


def production_thread_ids() -> set[str]:
    """Every thread id any production case already claims."""
    ids: set[str] = set()
    con = _ro_db()
    try:
        for table in ("personal_cases", "zst_cases"):
            try:
                rows = con.execute(f"SELECT gmail_thread_ids, source_references FROM {table}").fetchall()
            except sqlite3.Error:
                continue
            for blobs in rows:
                for blob in blobs:
                    if not blob:
                        continue
                    text = str(blob).strip()
                    if text.startswith("["):
                        try:
                            ids.update(str(x) for x in json.loads(text))
                            continue
                        except Exception:
                            pass
                    ids.add(text)
    finally:
        con.close()
    return ids


def _connector(account: str):
    path = os.path.join(REPO, "mcp-servers",
                        "google-zst-mcp.py" if account == "zst" else "google-private-mcp.py")
    spec = importlib.util.spec_from_file_location(f"conn_{account}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def provider_snippets(account: str, start: dt.date, end: dt.date, maximum: int = 500) -> dict[str, dict[str, Any]]:
    """The provider's own view of each message in the anchor window.

    Daily windows, same as the corpus exporter, so a day that hits the result cap
    is visible rather than silently truncating the sweep's input.
    """
    mod = _connector(account)
    out: dict[str, dict[str, Any]] = {}
    day = start
    while day < end:
        nxt = min(day + dt.timedelta(days=1), end)
        for direction, folder in (("INBOUND", "in:inbox"), ("OUTBOUND", "in:sent")):
            q = f"{folder} after:{day:%Y/%m/%d} before:{nxt:%Y/%m/%d} -in:spam -in:trash"
            rows = mod.t_gmail_search({"query": q, "max_results": maximum})
            if isinstance(rows, dict) and rows.get("error"):
                raise SystemExit(f"{account}: search failed: {str(rows)[:200]}")
            if len(rows) >= maximum:
                raise SystemExit(f"{account}: day hit max_results ({maximum}): {q}")
            for r in rows:
                mid = str(r.get("id") or "")
                if mid:
                    out[mid] = {**r, "_direction": direction}
        day = nxt
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--start", default="2026-06-17")
    ap.add_argument("--end", default="2026-08-17")
    args = ap.parse_args()

    before = safety_counts()
    corpus = json.load(open(args.corpus, encoding="utf-8"))
    claimed = production_thread_ids()

    threads: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for m in corpus["messages"]:
        threads.setdefault((m["sourceAccountId"], m["threadId"]), []).append(m)
    targets = {k: v for k, v in threads.items() if k[1] not in claimed}

    start, end = dt.date.fromisoformat(args.start), dt.date.fromisoformat(args.end)
    snippets: dict[str, dict[str, dict[str, Any]]] = {}
    for account in sorted({k[0] for k in targets}):
        snippets[account] = provider_snippets(account, start, end)
        print(f"... {account}: {len(snippets[account])} provider snippets", file=sys.stderr, flush=True)

    records: list[dict[str, Any]] = []
    for (account, tid), msgs in sorted(targets.items()):
        msgs = sorted(msgs, key=lambda m: m["occurredAt"])
        latest = msgs[-1]
        prov = snippets.get(account, {}).get(latest["messageId"])

        if prov is None or not (prov.get("snippet") or "").strip():
            records.append({
                "account": account, "domain": "zst" if account == "zst" else "personal",
                "threadId": tid, "messageCount": len(msgs),
                "latestSourceTimestamp": latest["occurredAt"],
                "productionCaseExists": False,
                "inputEquivalence": "RETRIAGE_INPUT_NOT_EQUIVALENT",
                "reasonCodes": ["PROVIDER_SNIPPET_UNAVAILABLE"],
                "currentVerdict": "UNKNOWN",
                "humanReviewRequired": False,
                "note": "the production-shaped input cannot be reproduced; the body is NOT "
                        "used as a substitute snippet",
            })
            continue

        candidate = {
            "account": account, "id": latest["messageId"], "threadId": tid,
            "direction": latest["direction"],
            "from": prov.get("from"), "subject": prov.get("subject"),
            "date": prov.get("date"), "snippet": (prov.get("snippet") or "")[:300],
        }
        candidate["sourceManifestHash"] = FEED._source_manifest_hash(candidate)

        noise = latest["direction"] == "INBOUND" and FEED.is_noise({
            "from": candidate["from"], "subject": candidate["subject"],
            "snippet": candidate["snippet"],
        })
        records.append({
            "account": account, "domain": "zst" if account == "zst" else "personal",
            "threadId": tid, "messageCount": len(msgs),
            "latestSourceTimestamp": latest["occurredAt"],
            "productionCaseExists": False,
            "inputEquivalence": "INPUT_EQUIVALENT",
            "messageId": latest["messageId"],
            "direction": latest["direction"],
            "from": candidate["from"], "subject": candidate["subject"],
            "snippet": candidate["snippet"],
            "sourceManifestHash": candidate["sourceManifestHash"],
            "currentVerdict": "NON_ACTIONABLE" if noise else "NEEDS_MODEL_JUDGEMENT",
            "reasonCodes": ["DETERMINISTIC_NOISE_FILTER"] if noise else ["SURVIVED_NOISE_FILTER"],
            "humanReviewRequired": False,
        })

    after = safety_counts()
    changed = {t: (before[t], after[t]) for t in SAFETY_TABLES if before[t] != after[t]}

    summary = {
        "generatedAt": int(dt.datetime.now(dt.timezone.utc).timestamp()),
        "mode": "SHADOW_NO_EFFECT",
        "totalCorpusThreads": len(threads),
        "targetThreads": len(targets),
        "fullyEvaluated": sum(1 for r in records if r["inputEquivalence"] == "INPUT_EQUIVALENT"),
        "inputNotEquivalent": sum(1 for r in records if r["inputEquivalence"] != "INPUT_EQUIVALENT"),
        "unknown": sum(1 for r in records if r["currentVerdict"] == "UNKNOWN"),
        "nonActionableDeterministic": sum(1 for r in records if r["currentVerdict"] == "NON_ACTIONABLE"),
        "needsModelJudgement": sum(1 for r in records if r["currentVerdict"] == "NEEDS_MODEL_JUDGEMENT"),
        "byDomain": {
            d: sum(1 for r in records if r["domain"] == d) for d in ("personal", "zst")
        },
        "rulePromptFingerprint": FEED._prompt_fingerprint(),
        "safetyCounts": {"before": before, "after": after, "changed": changed},
        "safetyVerdict": "PASS" if not changed else "FAIL",
        "notMeasured": "no historical accuracy or miss rate is computed: the original "
                       "triage judgement was never recorded, so there is no ground truth",
    }

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".retriage-", dir=os.path.dirname(out), text=True)
    os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "threads": records}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, out)
    os.chmod(out, 0o600)

    print(json.dumps(summary, ensure_ascii=False))
    if changed:
        raise SystemExit(f"SAFETY FAIL: production counts moved during a shadow sweep: {changed}")


if __name__ == "__main__":
    main()
