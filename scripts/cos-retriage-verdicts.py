#!/usr/bin/env python3
"""Stage 2H — the model-judgement half of the RETROSPECTIVE_RETRIAGE sweep.

The sweep script applies the deterministic rules (the production noise filter).
What survives needs a judgement, which in production is made by the triaging
agent under the heartbeat's rules. This file IS that judgement, written down
instead of narrated: every verdict is a rule with a reason code, so a reviewer
can disagree with a specific line rather than with a mood.

Still shadow: reads the sweep artifact, writes one report. No DB, no Gmail, no
case, no notification.

A candidate is NOT a claim that the past decision was wrong. There is no ground
truth to compare against, and this file computes no accuracy or miss rate.
"""
from __future__ import annotations
import argparse, collections, json, os, re, stat, tempfile
from typing import Any

ACTOR = "marveen"
MODEL = "claude-opus-5"

# (pattern on "from|subject", verdict, severity, caseType, reasonCode)
# Order matters: the first match wins, so the specific rules precede the broad
# ones. Severity ranks review urgency only -- it starts nothing.
RULES: list[tuple[str, str, str | None, str | None, str]] = [
    # ORDER IS THE POLICY. First match wins, so the exclusions come first.
    # Measured on my own first pass (2026-08-17): with quotes ahead of them, the
    # QuickQuote/Mondigo test traffic and a lead-generation newsletter were all
    # reported as "open quote threads". A rule list whose order is wrong does not
    # look wrong — it looks like findings.

    # --- Block A: never a case, whatever the words say ------------------------
    (r"(QuickQuote|mondigo\.eu|vidamo\.eu|no-reply@mail\.zstradio\.com|ajanlat@mondigo)", "NON_ACTIONABLE", None, None, "OWN_PRODUCT_TRAFFIC"),
    (r"(\[TESZT\]|\[TEST\]|complaint test|diag v\d|webhook.*test|\(TEST\))", "NON_ACTIONABLE", None, None, "OWN_TEST_TRAFFIC"),
    (r"Automatikus válasz|Auto[- ]?reply|out of office", "NON_ACTIONABLE", None, None, "AUTO_REPLY"),
    (r"(tudjukki\.hu|solarkit|szolgáltatások, amiket|legjobb árak következő)", "NON_ACTIONABLE", None, None, "LEAD_GENERATION_MARKETING"),

    # --- Block B: authority ---------------------------------------------------
    (r"tarhely\.gov\.hu.*Át nem vett", "ACTIONABLE", "P0", "ADMIN", "AUTHORITY_DOCUMENT_UNCOLLECTED"),
    (r"tarhely\.gov\.hu.*(Végrehaj|Fizetési kedvezmény|hianypotlas|hiánypótlás)", "ACTIONABLE", "P1", "ADMIN", "AUTHORITY_DOCUMENT_WITH_CONSEQUENCE"),
    (r"tarhely\.gov\.hu", "ACTIONABLE", "P2", "ADMIN", "AUTHORITY_DOCUMENT_PICKUP"),
    (r"uk\.visas.*(approved|processing|security code)", "NON_ACTIONABLE", None, None, "AUTHORITY_PROCESS_COMPLETED"),

    # --- Block C: money -------------------------------------------------------
    (r"(Sikertelen számlafizetés|Sikertelen számlabefizetés|Payment failure|Sikertelen bankkártyás)", "ACTIONABLE", "P1", "FINANCE", "PAYMENT_FAILED"),
    (r"tagdíjtartozás", "ACTIONABLE", "P2", "FINANCE", "OUTSTANDING_DEBT"),
    (r"biztosítás kötvénye törölve", "ACTIONABLE", "P1", "FINANCE", "INSURANCE_COVER_CANCELLED"),
    (r"(vízdíjszámlája|Számlaértesítő|Tax Invoice|Your receipt from|Számlája érkezett|Számlád a levélben|Számla érkezett)", "ACTIONABLE", "P2", "FINANCE", "INVOICE_RECEIVED"),
    (r"(Sikeres számlafizetés|Sikeres számlabefizetés|Sikeres tagdíjbefizetés|Sikeres bankkártyás)", "NON_ACTIONABLE", None, None, "PAYMENT_CONFIRMATION_ONLY"),

    # --- Block D: health ------------------------------------------------------
    (r"leletkuldes|Vizsgálati eredmény", "ACTIONABLE", "P1", "ADMIN", "MEDICAL_RESULT"),
    (r"(Andrássy Dent|Villányi Dent|andrassydental).*(Időpontfoglalás|^Re:|Re: Idő)", "ACTIONABLE", "P2", "CALL", "APPOINTMENT_THREAD"),

    # --- Block E: real counterparties -----------------------------------------
    (r"(Árajánlat|árajánlatkérés|ajánlatkérés|Ajánlat -|Ajánlat –|műszaki javaslat|Ajánlatkérés)", "ACTIONABLE", "P1", "QUOTE", "QUOTE_THREAD_OPEN"),
    (r"Reklamáci", "ACTIONABLE", "P2", "ADMIN", "COMPLAINT_THREAD_OPEN"),
    (r"(alkatrész beazonosítás|pótalkatrész)", "ACTIONABLE", "P2", "HOME_REPAIR", "PARTS_IDENTIFICATION_THREAD"),
    (r"OETP pályázat", "ACTIONABLE", "P2", "ADMIN", "GRANT_APPLICATION_STATUS"),
    (r"ENC eszközök visszaszolgáltatása", "ACTIONABLE", "P2", "ADMIN", "DEVICE_RETURN_REQUIRED"),
    (r"AKG2021|témahét|érettségi", "ACTIONABLE", "P1", "ADMIN", "SCHOOL_REQUEST"),
    (r"istvan\.szabo1@one\.hu", "ACTIONABLE", "P2", "EMAIL", "PERSONAL_THREAD_FAMILY"),
    (r"(johnsonpartners|spenglerfox)", "ACTIONABLE", "P2", "EMAIL", "CAREER_THREAD"),
    (r"(Szobafoglalas|reservation at|Check in previo|Foglalás módosítva)", "ACTIONABLE", "P2", "TRAVEL", "BOOKING_NEEDS_ACTION"),
    (r"(Terna|General Track|Raiffeisen|data migration|Meeting minutes|üzletrész-adásvétel|elszámolás)", "ACTIONABLE", "P2", "PARTNER", "BUSINESS_THREAD"),

    # --- Block F: infrastructure ---------------------------------------------
    (r"(Failed production deployment|Failed CLI deployment|Sikertelen callback)", "ACTIONABLE", "P2", "ADMIN", "SERVICE_FAILURE_NOTICE"),
    (r"(2-step verification|Password Reset|Secure Google Cloud)", "ACTIONABLE", "P2", "ADMIN", "ACCOUNT_SECURITY_ACTION"),
    (r"AWS Activate Credits", "ACTIONABLE", "P3", "ADMIN", "CREDIT_GRANTED"),

    # --- Block G: transactional noise ----------------------------------------
    (r"(Secure link to log in|confirmation code|security code|User code|verification code|Lépj vissza)", "NON_ACTIONABLE", None, None, "LOGIN_OR_VERIFICATION_LINK"),
    (r"(kézbesítés|csomagod|szállítás|Visszaküldés|rendelésed|megrendelését|Megvásároltad|order|delivery|shipped|tracking)", "NON_ACTIONABLE", None, None, "ORDER_LIFECYCLE_NOTIFICATION"),
    (r"(calendar-notification|Értesítés:|Emlékeztető az Ön foglalásáról|invitation|Elfogadva:|Accepted:)", "NON_ACTIONABLE", None, None, "CALENDAR_NOTIFICATION"),
    (r"(DKIM setup SUCCESS|services back online|Order Summary|regisztráció|Üdvözlünk|Welcome|E-mail confirmation|Felhasználói e-mail ellenőrzés|New login|was added to your|balance for)", "NON_ACTIONABLE", None, None, "SERVICE_NOTIFICATION"),
    (r"(tickets for|Tu entrada|Simplified invoice|Confirmation$|visszaigazol)", "NON_ACTIONABLE", None, None, "ORDER_OR_TICKET_CONFIRMATION"),
]

MARKETING = re.compile(
    r"(hírlevel|newsletter|kedvezmén|akció|-\d{1,2}%|ajánlatok|Utolsó esély|Kiárusítás|"
    r"Meghívó|invited to|survey|kérdőív|felmérés|feedback|Recommend|tippek|Bestseller|"
    r"nyereményjáték|Új ajánlatok|Friss hírek|Aktualitások|Befektetési|Kitekintő)", re.I)


def judge(rec: dict[str, Any]) -> tuple[str, str | None, str | None, str]:
    hay = f"{rec.get('from') or ''}|{rec.get('subject') or ''}|{rec.get('snippet') or ''}"
    for pattern, verdict, severity, case_type, reason in RULES:
        if re.search(pattern, hay, re.I):
            return verdict, severity, case_type, reason
    if MARKETING.search(hay):
        return "NON_ACTIONABLE", None, None, "MARKETING_PASSED_DETERMINISTIC_FILTER"
    if (rec.get("direction") == "SENT"):
        # Outbound needs the stricter test: only a send where the ball is now
        # with the other side is a case. Without the body we cannot tell.
        return "UNKNOWN", None, None, "OUTBOUND_BALL_POSITION_UNDECIDABLE_FROM_SNIPPET"
    return "UNKNOWN", None, None, "NO_RULE_MATCHED"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    data = json.load(open(args.sweep, encoding="utf-8"))
    threads = data["threads"]
    fingerprint = data["summary"]["rulePromptFingerprint"]

    for rec in threads:
        if rec["currentVerdict"] != "NEEDS_MODEL_JUDGEMENT":
            rec["judgedBy"] = "DETERMINISTIC_RULES"
            continue
        verdict, severity, case_type, reason = judge(rec)
        rec["currentVerdict"] = verdict
        rec["reasonCodes"] = rec.get("reasonCodes", []) + [reason]
        rec["judgedBy"] = f"MODEL:{MODEL}"
        rec["triageActor"] = ACTOR
        rec["rulePromptFingerprint"] = fingerprint
        if verdict == "ACTIONABLE":
            rec["candidateSeverity"] = severity
            rec["proposedCaseType"] = case_type
            rec["proposedTitle"] = (rec.get("subject") or "").strip()[:120] or "(no subject)"
            rec["candidateOnly"] = "proposed type/title are a CANDIDATE, not historical truth"
            rec["humanReviewRequired"] = True

    actionable = [r for r in threads if r["currentVerdict"] == "ACTIONABLE"]
    # same-matter grouping: identical sender + normalised subject stem
    groups: dict[tuple[str, str], list[str]] = collections.defaultdict(list)
    for r in actionable:
        stem = re.sub(r"(?i)^(re|fwd|fw)[:\s]+", "", (r.get("subject") or "")).strip()[:40].lower()
        groups[(r.get("from") or "", stem)].append(r["threadId"])
    dup_groups = {f"{k[0]} :: {k[1]}": v for k, v in groups.items() if len(v) > 1}

    sev = collections.Counter(r.get("candidateSeverity") for r in actionable)
    summary = {
        **data["summary"],
        "judgementPass": {
            "actor": ACTOR, "model": MODEL, "rulePromptFingerprint": fingerprint,
            "actionableCandidates": len(actionable),
            "nonActionable": sum(1 for r in threads if r["currentVerdict"] == "NON_ACTIONABLE"),
            "unknown": sum(1 for r in threads if r["currentVerdict"] == "UNKNOWN"),
            "byDomainActionable": collections.Counter(r["domain"] for r in actionable),
            "candidateSeverity": {k: v for k, v in sev.items() if k},
            "sameMatterGroups": len(dup_groups),
            "sameMatterMembers": sum(len(v) for v in dup_groups.values()),
            "severityStartsNothing": "severity ranks review urgency only; no action is triggered by it",
        },
        "duplicateGroups": dup_groups,
    }

    out = os.path.abspath(args.out)
    fd, tmp = tempfile.mkstemp(prefix=".retriage-judged-", dir=os.path.dirname(out), text=True)
    os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "threads": threads}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, out)
    os.chmod(out, 0o600)
    print(json.dumps(summary["judgementPass"], ensure_ascii=False, default=dict))


if __name__ == "__main__":
    main()
