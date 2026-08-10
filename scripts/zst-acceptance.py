#!/usr/bin/env python3
"""ZST (corporate) CoS acceptance gate — the corporate half of the measurement.

Why this file exists. Until 2026-08-10 the personal CoS had a runnable gate and
the corporate CoS had a hand-written audit document. That asymmetry is itself a
defect: the gap analysis of 2026-08-10 found three real problems (27 frozen
cases, an unreachable outbound chain, reconcile blind to the corporate side) that
a runnable gate would have shown as RED the moment they appeared. A document
cannot go red.

It deliberately does NOT re-implement the helpers. The search discipline lives in
cos-acceptance.py (positive control before any negative claim, comments are not
call sites, the scheduler reads the SKILL.md name and so do we) and is imported
from there. A standard that exists twice drifts.

Criteria derive from the ZST CoS v1.1 spec (§4 scope, §6 tables, §7 outbound,
§9 concurrency, §14 scheduling, §19 monitoring, §32 AT-Z* acceptance tests) and
from the measured incidents of 2026-08-09/10.

Result vocabulary and the UNKNOWN-is-not-PASS rule follow cos-acceptance.py.

Stdlib only. Read-only: it never writes to the store or the repo.

Usage:
  python3 scripts/zst-acceptance.py
  python3 scripts/zst-acceptance.py --json
  python3 scripts/zst-acceptance.py --group outbound
Exit code 0 only when every criterion is PASS.
"""
import importlib.util, json, os, subprocess, sys

REPO = os.environ.get("MARVEEN_REPO_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- reuse the personal gate's helpers ---------------------------------------
# Importing by path because the filename has a hyphen. Loading the module also
# registers the 35 personal criteria into ITS list; ours is separate, so the two
# gates never contaminate each other's counts.
_spec = importlib.util.spec_from_file_location(
    "cos_acceptance", os.path.join(REPO, "scripts", "cos-acceptance.py"))
_cos = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_cos)

PASS, FAIL, UNKNOWN, ERROR = _cos.PASS, _cos.FAIL, _cos.UNKNOWN, _cos.ERROR
q, one, cols, table_sql = _cos.q, _cos.one, _cos.cols, _cos.table_sql
prod_files, has_prod_caller, search_usable = _cos.prod_files, _cos.has_prod_caller, _cos.search_usable
task_config, task_declared_name = _cos.task_config, _cos.task_declared_name
SRC = _cos.SRC

CRITERIA = []


def crit(cid, group, ref, title):
    def deco(fn):
        CRITERIA.append({"id": cid, "group": group, "ref": ref, "title": title, "fn": fn})
        return fn
    return deco


def _table_missing(name):
    return table_sql(name) is None


# ---- group: engine (§6, §9) --------------------------------------------------

@crit("ZE-1", "engine", "§6, §9", "minden ZST ügynek van haladás-állapot sora")
def _ze1():
    if _table_missing("zst_cases") or _table_missing("case_progression_state"):
        return ERROR, "hiányzó tábla"
    missing = one("""SELECT COUNT(*) FROM zst_cases z WHERE NOT EXISTS
                     (SELECT 1 FROM case_progression_state s
                      WHERE s.case_id = z.case_id AND s.domain = 'zst')""")
    total = one("SELECT COUNT(*) FROM zst_cases")
    return (PASS if missing == 0 else FAIL), "%d/%d ügy állapot-sor nélkül" % (missing, total)


@crit("ZE-2", "engine", "incidens 2026-08-09", "nincs nem-lezárt ZST ügy kikapcsolt haladás-kapcsolóval")
def _ze2():
    """The freeze detector. 2026-08-09 19:01:57 the engine auto-closed all 27 ZST
    cases; the revert put the STATUS back to NEW and left progression_enabled at
    0, so the board showed 27 live cases the engine would never look at again. A
    status-only check cannot see this: the two fields have to be read together."""
    if _table_missing("zst_cases") or _table_missing("case_progression_state"):
        return ERROR, "hiányzó tábla"
    rows = q("""SELECT z.status, COUNT(*) FROM zst_cases z
                JOIN case_progression_state s ON s.case_id = z.case_id AND s.domain = 'zst'
                WHERE s.progression_enabled = 0
                  AND z.status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
                GROUP BY z.status ORDER BY COUNT(*) DESC""")
    frozen = sum(r[1] for r in rows)
    if frozen == 0:
        return PASS, "nincs befagyott ügy"
    detail = ", ".join("%s: %d" % (r[0], r[1]) for r in rows)
    stamps = q("""SELECT s.updated_at, COUNT(*) FROM zst_cases z
                  JOIN case_progression_state s ON s.case_id = z.case_id AND s.domain='zst'
                  WHERE s.progression_enabled = 0
                    AND z.status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
                  GROUP BY s.updated_at ORDER BY COUNT(*) DESC LIMIT 1""")
    when = ""
    if stamps and stamps[0][1] > 1:
        import datetime
        when = " — %d közülük azonos időbélyeggel: %s" % (
            stamps[0][1], datetime.datetime.fromtimestamp(stamps[0][0]).strftime("%Y-%m-%d %H:%M:%S"))
    return FAIL, "%d befagyott ügy (%s)%s" % (frozen, detail, when)


@crit("ZE-3", "engine", "§9, AT-ZG06/07", "a ZST oldalon van claim/fencing")
def _ze3():
    if _table_missing("zst_case_claims"):
        return FAIL, "nincs zst_case_claims tábla"
    c = cols("zst_case_claims")
    need = {"claim_key", "owner_run_id", "claim_fence", "claim_expires_at"}
    missing = need - set(c)
    if missing:
        return FAIL, "hiányzó oszlop: %s" % ", ".join(sorted(missing))
    stale = one("SELECT COUNT(*) FROM zst_case_claims WHERE claim_expires_at < strftime('%s','now')")
    return PASS, "fence megvan; %d lejárt claim bent felejtve" % stale


# ---- group: intake (§4, §8, AT-ZS01) ----------------------------------------

@crit("ZI-1", "intake", "§8", "minden feldolgozott ZST üzenet hordoz szálazonosítót")
def _zi1():
    if _table_missing("zst_email_processing"):
        return ERROR, "nincs zst_email_processing tábla"
    total = one("SELECT COUNT(*) FROM zst_email_processing")
    nulls = one("SELECT COUNT(*) FROM zst_email_processing WHERE thread_id IS NULL OR thread_id = ''")
    if total == 0:
        return UNKNOWN, "nincs feldolgozott üzenet, nincs mit mérni"
    return (PASS if nulls == 0 else FAIL), "%d/%d sor szálazonosító nélkül" % (nulls, total)


@crit("ZI-2", "intake", "v4.2.1 A.3", "a ZST feldolgozási napló egyedi kulcsa tartalmazza a thread_id-t")
def _zi2():
    """The personal side satisfies this (IN-1). The corporate table was created
    with UNIQUE(gmail_account_id, message_id) only — same rule, weaker key."""
    sql = table_sql("zst_email_processing")
    if not sql:
        return ERROR, "nincs zst_email_processing tábla"
    uniques = [l.strip() for l in sql.splitlines() if "UNIQUE" in l]
    ok = any("thread_id" in u for u in uniques)
    return (PASS if ok else FAIL), "; ".join(uniques) or "nincs UNIQUE"


@crit("ZI-3", "intake", "§4", "a ZST beérkezésnek van éles hívója")
def _zi3():
    live, detail = has_prod_caller("ingestTriagedZstEmail", "zst-intake.ts")
    if live is None:
        return ERROR, detail
    return (PASS if live else FAIL), detail


@crit("ZI-4", "intake", "AT-ZS01", "a céges tárba idegen fiókból csak JELÖLT üzenet került")
def _zi4():
    """The corporate boundary is connector identity (the v1.1 deviation Istvan
    agreed to): not a classifier, the account itself.

    CORRECTED 2026-08-10, first live run of this criterion. It went red on one
    row from the private mailbox and called it a foreign account. That row is
    the Vámosi thread: corporate content that arrived in the private mailbox,
    which the scope gate moved to the corporate store and MARKED for human
    review. That is the content-decides rule Istvan settled on 2026-08-09,
    working exactly as decided -- so the criterion was measuring a rule that had
    already been superseded, and a gate that fails on a settled decision gets
    switched off rather than obeyed.

    What the boundary actually protects is SILENT crossing. The personal gate
    (cos-acceptance SC-2) has said so since it was written: a marked case that
    is visible on the board and waiting on the owner is not contamination. The
    two gates measure the same boundary from opposite sides, so they have to
    agree on what a violation is; this one was the asymmetric half.

    Unmarked crossing is still a failure, and marked crossings are still
    counted out loud rather than hidden."""
    if _table_missing("zst_email_processing"):
        return ERROR, "nincs zst_email_processing tábla"
    rows = q("SELECT gmail_account_id, message_id, case_id FROM zst_email_processing")
    if not rows:
        return UNKNOWN, "nincs feldolgozott üzenet, a határ nem mérhető"
    foreign = [r for r in rows if r[0] != "zst"]
    if not foreign:
        return PASS, "fiókok: %s" % ", ".join(sorted({r[0] for r in rows}))

    # A crossing is legitimate only when the case it landed on carries the scope
    # gate's marker. No marker means nobody was told.
    unmarked = []
    for acct, msg_id, case_id in foreign:
        marked = False
        if case_id and not _table_missing("zst_cases"):
            reason = one("SELECT blocked_reason FROM zst_cases WHERE case_id = ?", case_id)
            marked = (reason or "").startswith("SCOPE REVIEW")
        if not marked:
            unmarked.append("%s/%s" % (acct, msg_id))
    if unmarked:
        return FAIL, "%d jelöletlen átlépés a céges naplóba: %s" % (
            len(unmarked), ", ".join(sorted(unmarked)[:4]))
    return PASS, "%d átlépés, mind SCOPE REVIEW-val jelölve (tartalom dönt, 2026-08-09)" % len(foreign)


# ---- group: outbound (§7, §15, AT-ZA) ---------------------------------------

@crit("ZO-1", "outbound", "§7.3, AT-ZA", "a ZST küldési folyamatnak van éles hívója")
def _zo1():
    """The one that matters most. dispatchZstSend is complete and unit-tested;
    if nothing outside its own file calls it, the corporate CoS cannot send, and
    'write-half DONE' describes a module, not a capability."""
    live, detail = has_prod_caller("dispatchZstSend", "zst-send.ts")
    if live is None:
        return ERROR, detail
    if not live:
        used = one("SELECT COUNT(*) FROM zst_outbound_ledger") if not _table_missing("zst_outbound_ledger") else None
        return FAIL, "%s; a kimenő napló %s sort tartalmaz" % (detail, used if used is not None else "?")
    return PASS, detail


@crit("ZO-2", "outbound", "§6.2", "a ZST kimenő napló hordozza a címzettet és a szolgáltatói azonosítókat")
def _zo2():
    if _table_missing("zst_outbound_ledger"):
        return ERROR, "nincs zst_outbound_ledger tábla"
    need = {"recipient", "external_ref", "external_idempotency_marker", "internal_idempotency_key"}
    missing = need - set(cols("zst_outbound_ledger"))
    return (PASS if not missing else FAIL), "hiányzó: %s" % (", ".join(sorted(missing)) or "-")


@crit("ZO-3", "outbound", "AT-ZA04/05", "a jóváhagyás konkrét címzett-listát engedélyez, és a küldés ezt nézi")
def _zo3():
    if _table_missing("zst_campaign_approvals"):
        return ERROR, "nincs zst_campaign_approvals tábla"
    if "allowed_recipients" not in cols("zst_campaign_approvals"):
        return FAIL, "a jóváhagyási sor nem hordoz címzett-listát"
    if not search_usable():
        return ERROR, "positive control failed"
    hits = prod_files("allowed_recipients", "cos") or []
    enforcing = [os.path.basename(h) for h in hits if os.path.basename(h) != "schema.ts"]
    if not enforcing:
        return FAIL, "az oszlop létezik, de éles kód nem olvassa"
    # Structural truth is not operational truth: if the only enforcer is a module
    # nothing invokes, the guard is real but unreachable. ZO-1 carries that
    # verdict; this criterion must not read as reassurance on its own.
    reachable, _ = has_prod_caller("dispatchZstSend", "zst-send.ts")
    note = "" if reachable else " — FIGYELEM: a kikényszerítő út maga hívó nélküli (lásd ZO-1)"
    return PASS, "kikényszerítve: %s%s" % (", ".join(sorted(enforcing)), note)


@crit("ZO-4", "outbound", "§15", "a ZST kampány-jóváhagyás mezői megegyeznek a személyessel")
def _zo4():
    p, z = set(cols("campaign_approvals")), set(cols("zst_campaign_approvals"))
    if not p or not z:
        return ERROR, "hiányzó jóváhagyási tábla"
    diff = p.symmetric_difference(z)
    return (PASS if not diff else FAIL), "eltérő mező: %s" % (", ".join(sorted(diff)) or "-")


# ---- group: liveness (built-but-never-invoked) ------------------------------

_ZST_MODULES = [
    ("zst-case-store.ts", "zst-case-store"),
    ("zst-intake.ts", "zst-intake"),
    ("zst-sensitivity.ts", "zst-sensitivity"),
    ("zst-finance.ts", "zst-finance"),
    ("zst-invoice-extract.ts", "zst-invoice-extract"),
    ("zst-contract-extract.ts", "zst-contract-extract"),
    ("zst-watch.ts", "zst-watch"),
    ("zst-send.ts", "zst-send"),
    ("zst-bank-import.ts", "zst-bank-import"),
    ("zst-productlab.ts", "zst-productlab"),
]


@crit("ZL-1", "liveness", "audit 2026-08-10", "minden ZST modult importál éles (nem teszt) kód")
def _zl1():
    """Module-level version of the personal LV-1. A module nothing imports is a
    module the running system does not have, however green its tests are."""
    if not search_usable():
        return ERROR, "positive control failed — grep result untrustworthy"
    orphans = []
    for filename, stem in _ZST_MODULES:
        path = os.path.join(SRC, "cos", filename)
        if not os.path.exists(path):
            orphans.append("%s (nincs ilyen fájl)" % stem)
            continue
        importers = set()
        for sub in ("cos", "web", "scripts"):
            for h in (prod_files("%s.js" % stem, sub) or []):
                if os.path.basename(h) != filename:
                    importers.add(os.path.basename(h))
        if not importers:
            orphans.append(stem)
    return (PASS if not orphans else FAIL), (
        "hívó nélkül: %s" % ", ".join(orphans) if orphans else "mind a %d modult importálja éles kód" % len(_ZST_MODULES))


# ---- group: monitoring (§19) ------------------------------------------------

@crit("ZM-1", "monitoring", "§19", "a napi rekonszilláció ránéz a ZST oldalra")
def _zm1():
    """2026-08-10: reconcile.ts and cos-daily-reconcile.ts contained zero `zst`
    references, which is why 27 frozen corporate cases stayed invisible for a
    day. Monitoring that does not look at a surface cannot report on it."""
    if not search_usable():
        return ERROR, "positive control failed"
    hits = set()
    for pat, sub in (("zst_cases", "cos"), ("zst_cases", "scripts"),
                     ("zst-", "cos"), ("zstReconcile", "cos")):
        for h in (prod_files(pat, sub) or []):
            if "reconcile" in os.path.basename(h):
                hits.add(os.path.basename(h))
    return (PASS if hits else FAIL), (
        ", ".join(sorted(hits)) if hits else "a rekonszilláció egyetlen ZST táblát sem néz")


# ---- group: scheduler (§14) -------------------------------------------------

@crit("ZS-1", "scheduler", "§14", "a ZST heti áttekintés ütemezve van és a deklarált neve egyezik")
def _zs1():
    cfg = task_config("zst-weekly-review")
    if cfg is None:
        return FAIL, "nincs zst-weekly-review ütemezett feladat"
    if not cfg.get("enabled", False):
        return FAIL, "a feladat létezik, de enabled=false"
    declared = task_declared_name("zst-weekly-review")
    if declared and declared != "zst-weekly-review":
        return FAIL, "a SKILL.md más néven deklarálja: %s (az ütemező ezt olvassa)" % declared
    return PASS, "cron=%s, enabled, deklarált név egyezik" % cfg.get("schedule")


# ---- group: finance (AT-ZF) -------------------------------------------------

@crit("ZF-1", "finance", "AT-ZF01", "a számla-duplikátum szerkezetileg kizárt")
def _zf1():
    sql = table_sql("zst_invoices")
    if not sql:
        return ERROR, "nincs zst_invoices tábla"
    uniques = [l.strip() for l in sql.splitlines() if "UNIQUE" in l]
    ok = any("duplicate_hash" in u for u in uniques)
    return (PASS if ok else FAIL), "; ".join(uniques) or "nincs UNIQUE"


@crit("ZF-2", "finance", "AT-ZF02", "kifizetettnek jelölt számlához banki bizonyíték kell")
def _zf2():
    sql = table_sql("zst_invoices")
    if not sql:
        return ERROR, "nincs zst_invoices tábla"
    checks = [l.strip() for l in sql.splitlines() if "CHECK" in l]
    ok = any("PAID" in c and "bank_transaction_id" in c for c in checks)
    if not ok:
        return FAIL, "nincs olyan CHECK, ami a PAID-hez banki tételt kötne"
    violating = one("SELECT COUNT(*) FROM zst_invoices WHERE payment_status='PAID' AND bank_transaction_id IS NULL")
    return (PASS if violating == 0 else FAIL), "CHECK megvan; %d sértő sor" % violating


# --- runner ------------------------------------------------------------------

GROUP_ORDER = ["engine", "intake", "outbound", "liveness", "monitoring", "scheduler", "finance"]
GROUP_LABEL = {
    "engine": "Motor és egyidejűség (§6, §9)",
    "intake": "Bejövő lánc és hatókör (§4, §8, AT-ZS01)",
    "outbound": "Kimenő és jóváhagyás (§7, §15, AT-ZA)",
    "liveness": "Élő hívó (built-but-never-invoked)",
    "monitoring": "Monitorozás (§19)",
    "scheduler": "Ütemezés (§14)",
    "finance": "Pénzügy (AT-ZF)",
}
MARK = {PASS: "PASS", FAIL: "FAIL", UNKNOWN: "UNKN", ERROR: "ERR "}


def run(group_filter=None):
    results = []
    for c in CRITERIA:
        if group_filter and c["group"] != group_filter:
            continue
        try:
            status, evidence = c["fn"]()
        except Exception as e:
            status, evidence = ERROR, "%s: %s" % (type(e).__name__, e)
        results.append({"id": c["id"], "group": c["group"], "ref": c["ref"],
                        "title": c["title"], "status": status, "evidence": evidence})
    return results


def main():
    args = sys.argv[1:]
    gf = args[args.index("--group") + 1] if "--group" in args else None
    results = run(gf)
    counts = {s: sum(1 for r in results if r["status"] == s) for s in (PASS, FAIL, UNKNOWN, ERROR)}
    green = counts[FAIL] == 0 and counts[UNKNOWN] == 0 and counts[ERROR] == 0

    if "--json" in args:
        print(json.dumps({"green": green, "counts": counts, "results": results},
                         ensure_ascii=False, indent=1))
        return 0 if green else 1

    print("ZST acceptance gate — %d kritérium" % len(results))
    print("PASS %d   FAIL %d   UNKNOWN %d   ERROR %d" %
          (counts[PASS], counts[FAIL], counts[UNKNOWN], counts[ERROR]))
    print("KAPU: %s" % ("ZOLD" if green else "PIROS — az UNKNOWN nem PASS (APG 1.8 §3.7)"))
    for g in GROUP_ORDER:
        rows = [r for r in results if r["group"] == g]
        if not rows:
            continue
        print("\n%s" % GROUP_LABEL.get(g, g))
        for r in rows:
            print("  [%s] %-6s %-14s %s" % (MARK[r["status"]], r["id"], r["ref"], r["title"]))
            print("            %s" % r["evidence"])
    return 0 if green else 1


if __name__ == "__main__":
    sys.exit(main())
