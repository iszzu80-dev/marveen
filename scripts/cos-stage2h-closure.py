#!/usr/bin/env python3
"""Stage 2H — candidate resolution + safety closure (read-only).

A candidate found by the retrospective sweep says "today's rules would surface
this". It does NOT say the matter is still open. Between the mail and now there
may be a production case on another thread, a later mail that paid, cancelled,
refunded or superseded it, or simply a deadline that has already passed. This
script asks those questions against the corpus and the live store, and never
writes anything.

The distinction it protects: `missing_case` and `existing_case_reuse_candidate`
are different findings with different work behind them, and reporting the second
as the first inflates a backlog with matters that are already tracked.
"""
from __future__ import annotations
import argparse, collections, datetime as dt, json, os, re, sqlite3, stat, sys, tempfile
from typing import Any

REPO = os.environ.get("MARVEEN_REPO_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(REPO, "store", "claudeclaw.db")

RESOLUTION_WORDS = re.compile(
    # `töröl` alone misses "törlése": Hungarian drops the second vowel, so the
    # cancellation mail that resolved a candidate did not match its own word.
    # Found by the mandatory Rentalcars fixture, 2026-08-17.
    r"(?i)((?:törl|törö)|cancel|refund|visszatérít|jóváír|sikeres (fizet|bankkártyás|számla)|"
    r"kifizet|befizet|teljesít|lezár|megérkezett a fizetés|payment received|paid|"
    r"visszaigazol|confirmed|elfogad|approved|átvéve|kézbesítve|resolved|megoldva)")
# 6+ digit runs, booking refs (D0147…), invoice-ish numbers, authority doc ids
REFERENCE = re.compile(r"(?i)\b([A-Z]{0,3}\d{6,})\b")
AUTHORITY_SUBJECT = re.compile(
    r"(?i)Feladó:\s*([A-ZÁÉÍÓÖŐÚÜŰa-z]+)\s*,\s*Dokumentum:\s*([^-]+?)\s*-\s*([A-Za-z0-9\-]+)")


def ro_db() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def production_cases() -> list[dict[str, Any]]:
    con = ro_db()
    out: list[dict[str, Any]] = []
    try:
        for table, domain in (("personal_cases", "personal"), ("zst_cases", "zst")):
            try:
                rows = con.execute(
                    f"SELECT case_id, title, case_type, status, gmail_thread_ids, source_references FROM {table}"
                ).fetchall()
            except sqlite3.Error:
                continue
            for cid, title, ctype, status, tids, refs in rows:
                ids: set[str] = set()
                for blob in (tids, refs):
                    if not blob:
                        continue
                    t = str(blob).strip()
                    if t.startswith("["):
                        try:
                            ids.update(str(x) for x in json.loads(t)); continue
                        except Exception:
                            pass
                    ids.add(t)
                out.append({"caseId": cid, "domain": domain, "title": title or "", "caseType": ctype,
                            "status": status, "ids": ids})
    finally:
        con.close()
    return out


def table_count(name: str) -> int | str:
    con = ro_db()
    try:
        return con.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
    except sqlite3.Error:
        return "TABLE_ABSENT"
    finally:
        con.close()


def norm(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def stem(subject: str | None) -> str:
    return re.sub(r"(?i)^((re|fwd|fw)[:\s]+)+", "", subject or "").strip()[:48].lower()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--judged", required=True)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    judged = json.load(open(args.judged, encoding="utf-8"))
    corpus = json.load(open(args.corpus, encoding="utf-8"))
    threads = judged["threads"]
    cases = production_cases()
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())

    # ---- (2) target universe: cases vs distinct claimed threads -------------
    corpus_threads = {(m["sourceAccountId"], m["threadId"]) for m in corpus["messages"]}
    claimed_ids = set().union(*[c["ids"] for c in cases]) if cases else set()
    claimed_threads = {t for t in corpus_threads if t[1] in claimed_ids}
    cases_touching_corpus = [c for c in cases if any(t[1] in c["ids"] for t in corpus_threads)]
    by_thread: dict[str, list[str]] = collections.defaultdict(list)
    for c in cases_touching_corpus:
        for t in corpus_threads:
            if t[1] in c["ids"]:
                by_thread[t[1]].append(c["caseId"])
    shared = {tid: cids for tid, cids in by_thread.items() if len(cids) > 1}
    universe = {
        "corpusThreads": len(corpus_threads),
        "productionCasesTouchingCorpus": len(cases_touching_corpus),
        "distinctClaimedThreads": len(claimed_threads),
        "targetThreads": len(corpus_threads) - len(claimed_threads),
        "explanationOfTheGap":
            "the earlier figure counted CASES that touch the corpus; the sweep counts distinct "
            "THREADS that are claimed. They differ whenever two cases claim the same thread — "
            "the thread is one target, not two.",
        "threadsClaimedByMoreThanOneCase": {k: v for k, v in shared.items()},
        "sharedThreadCount": len(shared),
        "casesMinusThreads": len(cases_touching_corpus) - len(claimed_threads),
    }

    # ---- index of corpus messages for later-evidence lookups ----------------
    msgs = sorted(corpus["messages"], key=lambda m: m["occurredAt"])
    by_ref: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for m in msgs:
        text = f"{m.get('subject') or ''} {(m.get('bodyText') or '')[:400]}"
        for ref in set(REFERENCE.findall(text)):
            by_ref[ref].append(m)

    actionable = [t for t in threads if t["currentVerdict"] == "ACTIONABLE"]

    # ---- (7) same-matter clusters + existing-case reuse ---------------------
    clusters: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    for t in actionable:
        clusters[(norm(t.get("from")), stem(t.get("subject")))].append(t)

    def matching_case(rec: dict[str, Any]) -> dict[str, Any] | None:
        subj = norm(rec.get("subject"))
        words = {w for w in re.findall(r"[a-záéíóöőúüű]{5,}", subj)}
        best, best_score = None, 0
        for c in cases:
            if c["domain"] != rec["domain"]:
                continue
            ctitle = norm(c["title"])
            cwords = {w for w in re.findall(r"[a-záéíóöőúüű]{5,}", ctitle)}
            score = len(words & cwords)
            if score > best_score:
                best, best_score = c, score
        return {"caseId": best["caseId"], "title": best["title"], "status": best["status"],
                "sharedTerms": best_score} if best and best_score >= 2 else None

    for rec in actionable:
        subj = rec.get("subject") or ""
        refs = set(REFERENCE.findall(subj))
        later: list[dict[str, Any]] = []
        for ref in refs:
            for m in by_ref.get(ref, []):
                # NOT strictly later. The mandatory Rentalcars fixture (Istvan,
                # 2026-08-17) proved why: the insurance-cancellation mail and the
                # Booking.com cancellation carrying the SAME reference arrived in
                # the same minute, because they are one event reported twice. A
                # `>` test called that pair an open action item. The candidate's
                # own message is still excluded — a mail cannot resolve itself.
                if m["messageId"] == rec.get("messageId"):
                    continue
                if m["occurredAt"] >= rec["latestSourceTimestamp"] - 300 and RESOLUTION_WORDS.search(
                        f"{m.get('subject') or ''} {(m.get('bodyText') or '')[:300]}"):
                    later.append({"messageId": m["messageId"], "at": m["occurredAt"],
                                  "subject": (m.get("subject") or "")[:80], "ref": ref})
        case = matching_case(rec)
        cluster = clusters[(norm(rec.get("from")), stem(rec.get("subject")))]

        if later:
            rec["disposition"] = "RESOLVED_BY_LATER_EVIDENCE"
            rec["laterEvidence"] = later[:3]
        elif case:
            rec["disposition"] = "EXISTING_CASE_EVIDENCE"
            rec["existingCase"] = case
        elif len(cluster) > 1:
            rec["disposition"] = "DUPLICATE_SAME_MATTER"
            rec["clusterSize"] = len(cluster)
        else:
            rec["disposition"] = "CURRENTLY_ACTIONABLE"

        # ---- (4) freshness ---------------------------------------------------
        age_days = (now - rec["latestSourceTimestamp"]) / 86400
        rec["ageDays"] = round(age_days, 1)
        if rec["disposition"] in ("RESOLVED_BY_LATER_EVIDENCE",):
            rec["deadlineState"] = "SUPERSEDED_OR_RESOLVED"
        elif re.search(r"(?i)át nem vett|at nem vett", subj):
            # The notice itself announces a window that was missed. Calling it
            # "upcoming" would let a 25-day-old failure look like time in hand.
            rec["deadlineState"] = "DEADLINE_PASSED_STATUS_UNKNOWN"
        elif re.search(r"(?i)tarhely|hianypotlas|hiánypótlás|felhívás|határidő", subj):
            # authority pickup windows are ~30 days; past that we do not know
            rec["deadlineState"] = "DEADLINE_PASSED_STATUS_UNKNOWN" if age_days > 30 else "UPCOMING_DEADLINE"
        elif age_days > 30:
            rec["deadlineState"] = "DEADLINE_PASSED_STATUS_UNKNOWN"
        else:
            rec["deadlineState"] = "UPCOMING_DEADLINE"
        if rec["deadlineState"] == "DEADLINE_PASSED_STATUS_UNKNOWN" and rec["disposition"] == "CURRENTLY_ACTIONABLE":
            rec["disposition"] = "CURRENT_STATUS_UNKNOWN"

    # ---- (5) authority grouping --------------------------------------------
    authority: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for t in threads:
        if "tarhely.gov.hu" not in (t.get("from") or ""):
            continue
        m = AUTHORITY_SUBJECT.search(t.get("subject") or "")
        key = f"{m.group(1)} :: {m.group(2).strip()}" if m else "UNPARSED"
        authority[key].append({
            "domain": t["domain"], "threadId": t["threadId"], "docId": m.group(3) if m else None,
            "subject": (t.get("subject") or "").strip()[:90],
            "at": t["latestSourceTimestamp"], "verdict": t["currentVerdict"],
            "disposition": t.get("disposition"), "deadlineState": t.get("deadlineState"),
        })
    authority_groups = [
        {"authorityAndDocumentKind": k, "items": len(v),
         "latestAt": max(x["at"] for x in v),
         "latestSubject": max(v, key=lambda x: x["at"])["subject"],
         "domains": sorted({x["domain"] for x in v}),
         "anyStillActionable": any(x["disposition"] in ("CURRENTLY_ACTIONABLE", "CURRENT_STATUS_UNKNOWN") for x in v)}
        for k, v in sorted(authority.items(), key=lambda kv: -len(kv[1]))]

    # ---- (6) financial reconciliation ---------------------------------------
    finance = []
    for t in actionable:
        if t["reasonCodes"][-1] not in ("PAYMENT_FAILED", "INVOICE_RECEIVED", "INSURANCE_COVER_CANCELLED",
                                        "OUTSTANDING_DEBT"):
            continue
        sender = (t.get("from") or "").split("<")[-1].strip(">").lower()
        later_same_sender = [
            m for m in msgs
            if m["occurredAt"] > t["latestSourceTimestamp"]
            and sender and sender in (m.get("from") or "").lower()
            and RESOLUTION_WORDS.search(f"{m.get('subject') or ''} {(m.get('bodyText') or '')[:300]}")]
        finance.append({
            "domain": t["domain"], "reason": t["reasonCodes"][-1],
            "subject": (t.get("subject") or "")[:80], "at": t["latestSourceTimestamp"],
            "ageDays": t["ageDays"], "disposition": t["disposition"],
            "laterFromSameSender": [{"subject": (m.get("subject") or "")[:70], "at": m["occurredAt"]}
                                    for m in later_same_sender[:2]],
            "reconciled": bool(later_same_sender),
        })

    # ---- (8) UNKNOWN buckets -------------------------------------------------
    unknown = [t for t in threads if t["currentVerdict"] == "UNKNOWN"]
    buckets = collections.Counter()
    for t in unknown:
        sender = (t.get("from") or "?")
        dom = sender.split("@")[-1].strip(">").lower() if "@" in sender else sender
        buckets[dom] += 1
    top_unknown = [{"senderDomain": d, "threads": n,
                    "materiality": "LOW" if re.search(r"(temu|kayak|freeletics|citydeals|banggood|geekbuying|jysk|mobilfox|duolingo|foodora)", d)
                    else "MEDIUM" if re.search(r"(revolut|googleplay|google\.com|aws|render|namecheap|otp)", d)
                    else "REVIEW"}
                   for d, n in buckets.most_common(10)]

    disp = collections.Counter(t["disposition"] for t in actionable)
    cur = [t for t in actionable if t["disposition"] == "CURRENTLY_ACTIONABLE"]
    report = {
        "generatedAt": now, "mode": "READ_ONLY_NO_WRITE",
        "safety": {
            "cos_triage_provenance": table_count("cos_triage_provenance"),
            "personal_cases": table_count("personal_cases"),
            "zst_cases": table_count("zst_cases"),
            "email_processing": table_count("email_processing"),
            "zst_email_processing": table_count("zst_email_processing"),
            "note": "an absent table is reported as TABLE_ABSENT, never as null or zero",
        },
        "targetUniverse": universe,
        "candidateDisposition": dict(disp),
        "currentlyActionable": {
            "total": len(cur),
            "byDomain": dict(collections.Counter(t["domain"] for t in cur)),
            "bySeverity": dict(collections.Counter(t.get("candidateSeverity") for t in cur)),
        },
        "deadlineStates": dict(collections.Counter(t.get("deadlineState") for t in actionable)),
        "authorityGroups": authority_groups,
        "finance": finance,
        "sameMatterClusters": {
            "clusters": sum(1 for v in clusters.values() if len(v) > 1),
            "threadsInClusters": sum(len(v) for v in clusters.values() if len(v) > 1),
            "largest": sorted(({"from": k[0][:50], "stem": k[1], "threads": len(v),
                                "existingCase": (v[0].get("existingCase") or {}).get("caseId"),
                                "orphan": not any(x.get("existingCase") for x in v)}
                               for k, v in clusters.items() if len(v) > 1),
                              key=lambda x: -x["threads"])[:8],
        },
        "unknownBuckets": top_unknown,
        "topHumanReview": sorted(
            [{"domain": t["domain"], "severity": t.get("candidateSeverity"), "ageDays": t["ageDays"],
              "deadlineState": t["deadlineState"], "reason": t["reasonCodes"][-1],
              "subject": (t.get("subject") or "")[:80], "threadId": t["threadId"]}
             for t in actionable if t["disposition"] in ("CURRENTLY_ACTIONABLE", "CURRENT_STATUS_UNKNOWN")],
            key=lambda x: (x["severity"] or "P9", -x["ageDays"]))[:20],
    }

    out = os.path.abspath(args.out)
    fd, tmp = tempfile.mkstemp(prefix=".closure-", dir=os.path.dirname(out), text=True)
    os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"report": report, "threads": threads}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, out)
    os.chmod(out, 0o600)
    print(json.dumps(report, ensure_ascii=False, indent=1, default=str)[:6000])


if __name__ == "__main__":
    main()
