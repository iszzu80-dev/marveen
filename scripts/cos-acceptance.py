#!/usr/bin/env python3
"""COS acceptance gate — the gap analysis turned into a runnable check.

Every criterion derives from a named section of the spec (v4.2 / v4.2.1) or from
the 2026-08-09 audits, and is evaluated against the LIVE system: the store, the
production source, the scheduled-task config, the run log. Nothing here trusts a
document, a commit message or a previous audit.

Result vocabulary follows APG 1.8 §7.4 deliberately:
  PASS     the check really ran and the system met it
  FAIL     the check really ran and found a proven miss
  UNKNOWN  the check is applicable but there is not enough evidence to decide
  ERROR    the check could not run

APG 1.8 §3.7 (No Silent Unknown) is the rule that matters here: UNKNOWN is NOT a
pass. The gate is green only when every criterion is PASS.

Negative claims ("this identifier appears nowhere in production code") are only
made when a positive control for the same search shape succeeds — otherwise the
criterion returns ERROR rather than a false FAIL.

Stdlib only. Read-only: it never writes to the store or the repo.

Usage:
  python3 scripts/cos-acceptance.py            # human-readable report
  python3 scripts/cos-acceptance.py --json     # machine-readable
  python3 scripts/cos-acceptance.py --group intake
Exit code 0 only when every criterion is PASS.
"""
import json, os, re, sqlite3, subprocess, sys, time

REPO = os.environ.get("MARVEEN_REPO_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(REPO, "store", "claudeclaw.db")
SRC = os.path.join(REPO, "src")
TASKS = os.path.expanduser("~/.claude/scheduled-tasks")
DAY = 86400

PASS, FAIL, UNKNOWN, ERROR = "PASS", "FAIL", "UNKNOWN", "ERROR"

_db = None


def db():
    global _db
    if _db is None:
        _db = sqlite3.connect("file:%s?mode=ro" % DB_PATH, uri=True)
    return _db


def q(sql, *args):
    return db().execute(sql, args).fetchall()


def one(sql, *args):
    r = q(sql, *args)
    return r[0][0] if r else None


def cols(table):
    return [r[1] for r in q("PRAGMA table_info(%s)" % table)]


def table_sql(table):
    r = q("SELECT sql FROM sqlite_master WHERE name=?", table)
    return r[0][0] if r else None


# --- source search -----------------------------------------------------------

def prod_files(pattern, subdir="cos"):
    """Files under src/<subdir> containing `pattern`, excluding tests."""
    root = os.path.join(SRC, subdir) if subdir else SRC
    if not os.path.isdir(root):
        return None                      # caller turns this into ERROR
    try:
        out = subprocess.run(
            ["grep", "-rl", "--include=*.ts", pattern, root],
            capture_output=True, text=True, timeout=60,
        ).stdout
    except Exception:
        return None
    return [p for p in out.split() if "__tests__" not in p]


# A search shape that MUST find something. If it does not, the search itself is
# broken and every negative result in this run is untrustworthy.
POSITIVE_CONTROL = ("ingestEmail", "cos")


def search_usable():
    hits = prod_files(*POSITIVE_CONTROL)
    return bool(hits)


def absent_in_prod(pattern, subdir="cos"):
    """(is_absent, detail). Returns (None, reason) when the search is untrusted."""
    if not search_usable():
        return None, "positive control failed — grep result untrustworthy"
    hits = prod_files(pattern, subdir)
    if hits is None:
        return None, "search could not run"
    return (len(hits) == 0), "%d production file(s)" % len(hits)


_COMMENT = re.compile(r"^\s*(//|\*|/\*)")


def _references_outside_comments(path, symbol):
    """A mention inside a comment is NOT a caller. 2026-08-09: the first version
    of this check reported send-flow as live because zst-send.ts says
    'exactly like the personal send-flow' in a header comment. A grep that
    counts prose as a call site produces exactly the false green this whole
    gate exists to prevent."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if symbol in line and not _COMMENT.match(line):
                    return True
    except OSError:
        return False
    return False


def has_prod_caller(symbol, defining_file):
    """True when `symbol` is referenced by production CODE (not comments) in a
    file other than the one defining it. The built-but-never-invoked check."""
    if not search_usable():
        return None, "positive control failed"
    hits = (prod_files(symbol, "cos") or []) + (prod_files(symbol, "web") or [])
    callers = [h for h in hits
               if os.path.basename(h) != defining_file and _references_outside_comments(h, symbol)]
    return (len(callers) > 0), (", ".join(sorted({os.path.basename(c) for c in callers})) or "nincs éles hívó")


# --- scheduled tasks ---------------------------------------------------------

def task_config(name):
    p = os.path.join(TASKS, name, "task-config.json")
    if not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def task_declared_name(dirname):
    """The name the SCHEDULER uses — the SKILL.md frontmatter, not the directory.
    2026-08-09: renaming the directory and the config left the frontmatter saying
    `cos-progression-heartbeat`, so the running scheduler kept firing under the
    old name while a directory-based check reported the rename as complete. A
    criterion that reads a different field than the system reads is measuring a
    file, not a behaviour."""
    p = os.path.join(TASKS, dirname, "SKILL.md")
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("name:"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        return None
    return None


# --- criteria ----------------------------------------------------------------
# Each: (id, group, spec reference, title, fn) where fn -> (status, evidence)

CRITERIA = []


def crit(cid, group, ref, title):
    def deco(fn):
        CRITERIA.append({"id": cid, "group": group, "ref": ref, "title": title, "fn": fn})
        return fn
    return deco


# ---- group: intake (§6.3, §8) ----

@crit("IN-1", "intake", "v4.2.1 A.3", "email_processing egyedi kulcsa tartalmazza a thread_id-t")
def _in1():
    sql = table_sql("email_processing")
    if not sql:
        return ERROR, "email_processing tábla nincs"
    uniques = [l.strip() for l in sql.splitlines() if "UNIQUE" in l]
    ok = any("thread_id" in u for u in uniques)
    return (PASS if ok else FAIL), "; ".join(uniques) or "nincs UNIQUE"


@crit("IN-2", "intake", "§8", "minden feldolgozott üzenet hordoz szálazonosítót")
def _in2():
    nulls = one("SELECT COUNT(*) FROM email_processing WHERE thread_id IS NULL")
    total = one("SELECT COUNT(*) FROM email_processing")
    if total == 0:
        return UNKNOWN, "nincs feldolgozott üzenet, nincs mit mérni"
    return (PASS if nulls == 0 else FAIL), "%d/%d sor thread_id nélkül" % (nulls, total)


@crit("IN-3", "intake", "§8, AC-10", "az üzenetek eljutnak a terminális SOURCE_COMMITTED állapotig")
def _in3():
    cutoff = int(time.time()) - DAY
    stuck = one("SELECT COUNT(*) FROM email_processing WHERE status='LOCAL_APPLIED' AND updated_at < ?", cutoff)
    total = one("SELECT COUNT(*) FROM email_processing")
    if total == 0:
        return UNKNOWN, "nincs feldolgozott üzenet"
    return (PASS if stuck == 0 else FAIL), "%d üzenet áll LOCAL_APPLIED-ben 24 óránál régebben" % stuck


@crit("IN-4", "intake", "§8, AC-11", "a kötegek lezáródnak")
def _in4():
    cutoff = int(time.time()) - DAY
    open_old = one("SELECT COUNT(*) FROM email_processing_batches WHERE status IN ('OPEN','PROCESSING') AND updated_at < ?", cutoff)
    total = one("SELECT COUNT(*) FROM email_processing_batches")
    if total == 0:
        return UNKNOWN, "nincs köteg"
    return (PASS if open_old == 0 else FAIL), "%d/%d köteg nyitva 24 óránál régebben" % (open_old, total)


@crit("IN-5", "intake", "§6.4", "minden aktív fiókhoz tartozik cursor a checkpoint táblában")
def _in5():
    accounts = [r[0] for r in q("SELECT DISTINCT gmail_account_id FROM email_processing")]
    have = {r[0] for r in q("SELECT gmail_account_id FROM email_source_checkpoints")}
    missing = [a for a in accounts if a not in have]
    if not accounts:
        return UNKNOWN, "nincs aktív fiók"
    return (PASS if not missing else FAIL), "checkpoint hiányzik: %s" % (", ".join(missing) or "-")


@crit("IN-6", "intake", "§8", "a bejövő úton van teljes szál olvasás")
def _in6():
    absent, detail = absent_in_prod("gmail_read\\|threads/")
    if absent is None:
        return ERROR, detail
    return (FAIL if absent else PASS), detail


# ---- group: scope (§2, AC-17) ----

@crit("SC-1", "scope", "§2", "a Scope Gate mind a hat verdiktje létezik éles kódban")
def _sc1():
    verdicts = ["PERSONAL_PROBABLE", "AMBIGUOUS", "CORPORATE_EXCLUDED", "ZST_EXCLUDED", "SECURITY_BLOCKED"]
    missing = []
    for v in verdicts:
        absent, detail = absent_in_prod(v, None)
        if absent is None:
            return ERROR, detail
        if absent:
            missing.append(v)
    return (PASS if not missing else FAIL), "hiányzó verdikt: %s" % (", ".join(missing) or "-")


@crit("SC-2", "scope", "AC-17", "nincs JELÖLETLEN céges tartalom a személyes tárban")
def _sc2():
    # A kriterium neve "jelöletlen"-t mond, a check viszont eredetileg MINDEN
    # talalatot bukasnak vett. Amit az AC ved, az a NEMA szennyezodes: egy
    # megjelolt, a boardon lathato, tulajdonosi dontesre varo ugy nem az.
    # A jelolt eseteket kulon szamoljuk, hogy ne tunjenek el a szonyeg ala.
    rows = q("""SELECT case_id, title, blocked_reason FROM personal_cases
                WHERE archived_at IS NULL
                  AND (title LIKE '%ZST%' OR description LIKE '%ZST%'
                       OR title LIKE '%ONE Magyarorsz%' OR title LIKE '%Product Lab%')""")
    if not rows:
        return PASS, "nincs találat"
    unmarked = [r for r in rows if not (r[2] or "").startswith("SCOPE REVIEW")]
    if unmarked:
        return FAIL, "%d jelöletlen ügy: %s" % (len(unmarked), ", ".join(r[0] for r in unmarked[:4]))
    return PASS, "%d céges tartalmú ügy, mind JELÖLVE és tulajdonosi döntésre vár" % len(rows)


# ---- group: approval (§3.2, §3.3, §3.4) ----

APPROVAL_FIELDS = [
    "allowed_recipients", "allowed_channels", "template_id", "template_version",
    "allowed_variable_schema", "allowed_variable_sources", "forbidden_variables",
    "shareable_data", "quote_target_budget", "quote_hard_limit", "autonomous_spend_limit",
    "max_initial_outbound", "max_follow_up_outbound", "max_autonomous_replies",
    "max_total_outbound", "follow_up_policy", "allowed_reply_classes",
    "stop_conditions", "escalation_conditions", "final_gate", "valid_until",
]


@crit("AP-1", "approval", "§3.2", "a jóváhagyási boríték mind a 22 mezője létezik")
def _ap1():
    c = set(cols("campaign_approvals"))
    if not c:
        return ERROR, "campaign_approvals tábla nincs"
    missing = [f for f in APPROVAL_FIELDS if f not in c]
    return (PASS if not missing else FAIL), "%d hiányzó mező: %s" % (len(missing), ", ".join(missing[:5]) + ("…" if len(missing) > 5 else ""))


@crit("AP-2", "approval", "audit 2026-08-09", "a jóváhagyási réteg közös mag, nem két másolat")
def _ap2():
    personal = set(cols("campaign_approvals"))
    zst = set(cols("zst_campaign_approvals"))
    if not personal or not zst:
        return ERROR, "az egyik jóváhagyási tábla hiányzik"
    diff = personal.symmetric_difference(zst)
    # Check the PROPERTY, not a guessed filename. The first version of this
    # criterion grepped for a module called "campaign-approval-core" and kept
    # failing after the core landed as approval-core.ts — a criterion that
    # asserts a name rather than a structure measures my naming, not the system.
    # A shared core means: one module defines the engine for BOTH namespaces.
    shared = [f for f in (prod_files("personalApprovals", "cos") or [])
              if f in (prod_files("zstApprovals", "cos") or [])]
    if shared and not diff:
        return PASS, "közös mag: %s, és a két tábla szimmetrikus" % ", ".join(os.path.basename(f) for f in shared)
    if shared:
        return FAIL, "van közös mag, de a két tábla eltér: %s" % ", ".join(sorted(diff))
    return FAIL, "nincs közös mag; a két tábla eltérése: %s" % (", ".join(sorted(diff)) or "azonos, de duplikált")


@crit("AP-3", "approval", "§3.3, AC-5", "a renderelt payload változó-validációja létezik")
def _ap3():
    absent, detail = absent_in_prod("allowed_variable\\|forbiddenVariable\\|forbidden_variable")
    if absent is None:
        return ERROR, detail
    return (FAIL if absent else PASS), detail


@crit("AP-4", "approval", "§3.4, AC-6", "a reply-policy megállási feltételei léteznek")
def _ap4():
    absent, detail = absent_in_prod("stop_conditions\\|stopConditions")
    if absent is None:
        return ERROR, detail
    return (FAIL if absent else PASS), detail


@crit("AP-5", "approval", "AC-4", "a személyes oldalon is kikényszerített a címzett-allowlist")
def _ap5():
    if "allowed_recipients" not in set(cols("campaign_approvals")):
        return FAIL, "campaign_approvals.allowed_recipients nincs (a ZST oldalon van)"
    absent, detail = absent_in_prod("allowed_recipients")
    if absent is None:
        return ERROR, detail
    return (PASS if not absent else FAIL), detail


# ---- group: outbound (§6.2, §7.3, A.5) ----

@crit("OU-1", "outbound", "§6.2", "az outbound_ledger hordozza a címzettet és a szolgáltatói azonosítókat")
def _ou1():
    c = set(cols("outbound_ledger"))
    if not c:
        return ERROR, "outbound_ledger nincs"
    need = ["recipient", "campaign_id", "channel", "provider_message_id", "rfc_message_id"]
    missing = [f for f in need if f not in c]
    return (PASS if not missing else FAIL), "hiányzó: %s" % (", ".join(missing) or "-")


@crit("OU-2", "outbound", "v4.2.1 A.5, AC-21", "a ledger rögzíti a kampány- és approval-verziót")
def _ou2():
    c = set(cols("outbound_ledger"))
    missing = [f for f in ("campaign_version", "approval_version") if f not in c]
    return (PASS if not missing else FAIL), "hiányzó: %s" % (", ".join(missing) or "-")


@crit("OU-3", "outbound", "§7.3", "a küldési folyamatnak van éles hívója")
def _ou3():
    ok, detail = has_prod_caller("dispatchApprovedSend", "send-flow.ts")
    if ok is None:
        return ERROR, detail
    return (PASS if ok else FAIL), detail


@crit("OU-4", "outbound", "§15", "a kampány-életciklus mezői léteznek")
def _ou4():
    c = set(cols("campaigns"))
    need = ["revoked_at", "revoked_by", "pause_reason", "outbound_count", "follow_up_count", "last_activity_at"]
    missing = [f for f in need if f not in c]
    return (PASS if not missing else FAIL), "hiányzó: %s" % (", ".join(missing) or "-")


# ---- group: liveness (built-but-never-invoked) ----

LIVENESS = [
    ("sourceCommit", "email-ingest.ts", "§8 forrás-commit"),
    ("tryAdvanceCheckpoint", "email-ingest.ts", "§8 cursor-léptetés"),
    ("claimMessage", "email-ingest.ts", "§9 claim"),
    ("quarantineMessage", "email-ingest.ts", "A.1 karantén"),
    ("reserveQuota", "quota.ts", "A.4 kvóta"),
    ("validateSkillPermissions", "skill-permission-validator.ts", "§24 skill-kapu"),
]


@crit("LV-1", "liveness", "audit 2026-08-09", "minden speccelt képességnek van éles hívója")
def _lv1():
    dead = []
    for sym, f, label in LIVENESS:
        ok, _ = has_prod_caller(sym, f)
        if ok is None:
            return ERROR, "positive control failed"
        if not ok:
            dead.append(label)
    return (PASS if not dead else FAIL), "hívó nélkül: %s" % (", ".join(dead) or "-")


@crit("LV-2", "liveness", "§9, AC-13", "az éles út ténylegesen szerez claimet")
def _lv2():
    n = one("SELECT COUNT(*) FROM case_claims")
    ever = one("SELECT COUNT(*) FROM personal_case_events WHERE event_type LIKE '%CLAIM%'")
    if n and n > 0:
        return PASS, "%d aktív claim" % n
    if ever:
        return PASS, "claim-esemény a naplóban"
    return FAIL, "0 claim a case_claims táblában, és nincs claim-esemény"


@crit("LV-3", "liveness", "§25/(3)", "a haladás-motor nem árnyék módban fut")
def _lv3():
    try:
        total = one("SELECT COUNT(*) FROM case_progression_runs")
        acted = one("""SELECT COUNT(*) FROM case_progression_runs
                       WHERE action_ids_json IS NOT NULL AND action_ids_json NOT IN ('','[]','null')""")
    except sqlite3.Error as e:
        return ERROR, str(e)
    if not total:
        return UNKNOWN, "nincs futás"
    return (PASS if acted > 0 else FAIL), "%d futásból %d javasolt külső műveletet" % (total, acted)


# ---- group: scheduler (§14) ----

SPEC_TASKS = ["personal-case-wake", "personal-gmail-delta", "personal-daily-reconcile", "personal-weekly-review"]


@crit("SD-1", "scheduler", "§14", "a spec négy ütemezett feladata létezik és engedélyezett")
def _sd1():
    if not os.path.isdir(TASKS):
        return ERROR, "a scheduled-tasks könyvtár nem érhető el"
    bad = []
    for t in SPEC_TASKS:
        cfg = task_config(t)
        if cfg is None:
            bad.append("%s: nincs" % t)
            continue
        if not cfg.get("enabled"):
            bad.append("%s: kikapcsolva" % t)
        declared = task_declared_name(t)
        # A SKILL.md-ben deklarált név az, amit az ütemező használ. Ha az eltér a
        # könyvtártól, a rendszer más néven fut, mint amit itt ellenőrzünk.
        if declared is not None and declared != t:
            bad.append("%s: az ütemező szerint '%s'" % (t, declared))
    return (PASS if not bad else FAIL), "; ".join(bad) or "mind a négy él, egyező néven"


@crit("SD-2", "scheduler", "audit 2026-08-09", "a haladás-motor ütemezése engedélyezett")
def _sd2():
    # Ugyanaz a feladat, 2026-08-09-en a spec §14 nevere atnevezve
    # (cos-progression-heartbeat -> personal-case-wake) es bekapcsolva.
    cfg = task_config("personal-case-wake") or task_config("cos-progression-heartbeat")
    if cfg is None:
        return FAIL, "az ugy-ebreszto feladat nincs"
    return (PASS if cfg.get("enabled") else FAIL), "enabled=%s" % cfg.get("enabled")


@crit("SD-3", "scheduler", "audit 2026-08-09", "a levélfigyelés köre nem esik ki csendben")
def _sd3():
    # A feladat 2026-08-09-en at lett nevezve a spec §14 nevere
    # (email-triage -> personal-gmail-delta), es orankentire allitva. A kriterium
    # a feladatot koveti, nem a regi nevet; a tartalma valtozatlan.
    cfg = task_config("personal-gmail-delta") or task_config("email-triage")
    if cfg is None:
        return FAIL, "a bejovo levelfigyelo feladat nincs"
    if cfg.get("skipIfBusy"):
        return FAIL, "skipIfBusy=true, 3 órás kadencián a kimaradt kör elvész"
    return PASS, "skipIfBusy=false"


# ---- group: monitoring (§19) ----

# §19 riasztas-temak. Temankent TOBB elfogadott irasmod: a kriterium a temat
# meri, nem azt hogy eltalaltam-e a valasztott elnevezest (2026-08-09: a
# "duplikáció" kulcsszo pirosat adott, mikozben a duplikacio-ellenorzes
# `duplicate_send_attempt` neven mar letezett).
MONITORED = {
    "duplikáció": ["duplikáci", "duplicate"],
    "OUTCOME_UNKNOWN": ["OUTCOME_UNKNOWN"],
    "readback": ["readback", "visszaolvas"],
    "campaign": ["campaign", "kampány"],
    "approval": ["approval", "jóváhagyás"],
    "connector": ["connector", "csatlakozó"],
    "scope": ["scope", "hatókör", "personal store"],
    "follow_up": ["follow_up", "follow-up", "utánkövet"],
    "radar": ["radar"],
    "cursor": ["cursor", "pozíció"],
}


@crit("MO-1", "monitoring", "§19", "a monitorozás lefedi a spec riasztásait")
def _mo1():
    # A riasztasok implementaciojat kovesd, ne egy fajlnevet: a listMonitoring
    # route csak KISZOLGALJA a reconcile talalatait, a temak ott laknak.
    files = (prod_files("listMonitoring", "web") or []) + (prod_files("runDailyReconcile", "cos") or [])
    if not files:
        return ERROR, "sem a listMonitoring, sem a reconcile nem található"
    body = ""
    for f in set(files):
        try:
            body += open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            pass
    low = body.lower()
    missing = [topic for topic, forms in MONITORED.items()
               if not any(fm.lower() in low for fm in forms)]
    covered = len(MONITORED) - len(missing)
    if missing:
        return FAIL, "%d/%d téma lefedve; hiányzik: %s" % (covered, len(MONITORED), ", ".join(missing))
    return PASS, "mind a %d riasztás-téma lefedve (%s)" % (
        len(MONITORED), ", ".join(sorted({os.path.basename(f) for f in files})))


@crit("MO-2", "monitoring", "audit 2026-08-09 G3", "van termelés-mérés küszöbbel")
def _mo2():
    absent, detail = absent_in_prod("outputFloor\\|expectedOutput\\|productionFloor\\|termelesi_kuszob", None)
    if absent is None:
        return ERROR, detail
    return (FAIL if absent else PASS), ("nincs termelés-küszöb ellenőrzés" if absent else detail)


# ---- group: migration (§17) ----

@crit("MG-1", "migration", "§17", "a migrált ügyek bizonytalansági jelölést hordoznak")
def _mg1():
    migrated = one("SELECT COUNT(*) FROM personal_cases WHERE source_system='chatgpt-cos-drive'")
    if not migrated:
        return UNKNOWN, "nincs migrált ügy"
    absent, _ = absent_in_prod("MIGRATED_UNVERIFIED", None)
    if absent is None:
        return ERROR, "positive control failed"
    if absent:
        return FAIL, "%d migrált ügy, a MIGRATED_UNVERIFIED jelölés sehol nincs a kódban" % migrated
    marked = one("SELECT COUNT(*) FROM personal_cases WHERE source_system='chatgpt-cos-drive' AND scope='MIGRATED_UNVERIFIED'")
    return (PASS if marked == migrated else FAIL), "%d/%d migrált ügy jelölve" % (marked or 0, migrated)


# ---- group: workflow (§13, §21, §25) ----

@crit("WF-1", "workflow", "§13.1", "az ajánlatkérő-kampány workflow státuszai léteznek")
def _wf1():
    missing = []
    for s in ("SHORTLIST_READY", "REQUESTS_SENDING", "QUOTES_COLLECTED", "COMPARISON_READY"):
        absent, detail = absent_in_prod(s, None)
        if absent is None:
            return ERROR, detail
        if absent:
            missing.append(s)
    return (PASS if not missing else FAIL), "hiányzó: %s" % (", ".join(missing) or "-")


@crit("WF-2", "workflow", "§21, §25/(4)", "legalább egy valós, többnapos kampány lezárult")
def _wf2():
    try:
        rows = q("SELECT campaign_id, status, created_at, updated_at FROM campaigns WHERE status='COMPLETED'")
    except sqlite3.Error as e:
        return ERROR, str(e)
    multi = [r for r in rows if (r[3] - r[2]) >= DAY]
    if multi:
        return PASS, "%d lezárt többnapos kampány" % len(multi)
    total = one("SELECT COUNT(*) FROM campaigns")
    return FAIL, "%d kampány összesen, 0 lezárt többnapos" % (total or 0)


@crit("WF-3", "workflow", "§22", "az autonómia-létra fokozatai léteznek")
def _wf3():
    missing = []
    for s in ("EXECUTE_WITH_APPROVAL", "LIMITED_AUTONOMOUS"):
        absent, detail = absent_in_prod(s, None)
        if absent is None:
            return ERROR, detail
        if absent:
            missing.append(s)
    return (PASS if not missing else FAIL), "hiányzó: %s" % (", ".join(missing) or "-")


@crit("LK-1", "linking", "kartya 4c6695d9", "ket ugy ossze TUD kotni (entitas-alapon, szalon tulmutatoan)")
def _lk1():
    # A kepesseg NEM LETEZETT: a related_case_ids oszlop ott volt, es semmi nem
    # tudta irni. A kriterium azt meri, hogy van-e iro ut, nem azt hogy van-e mezo.
    ok, detail = has_prod_caller("linkCases", "case-link.ts")
    if ok is None:
        return ERROR, detail
    return (PASS if ok else FAIL), detail


@crit("LK-2", "linking", "kartya 4c6695d9", "a futarcegek NEM szamitanak kereskedonek az illesztesben")
def _lk2():
    # Ha egy futar kereskedokent illeszkedne, a shopping ugyek fele osszedrotozodna.
    # Ez a kriterium a HAMIS KAPCSOLAT ellen ved, nem a hianyzo ellen.
    f = os.path.join(SRC, "cos", "case-link.ts")
    if not os.path.exists(f):
        return FAIL, "nincs case-link modul"
    try:
        body = open(f, encoding="utf-8", errors="replace").read()
    except OSError as e:
        return ERROR, str(e)
    if "CARRIERS" not in body:
        return FAIL, "nincs futar-kizaras"
    merch = body.split("export const MERCHANTS")[1].split("]")[0].lower() if "export const MERCHANTS" in body else ""
    leaked = [c for c in ("gls", "foxpost", "dpd", "posta") if "'%s'" % c in merch]
    return (PASS if not leaked else FAIL), ("futar a kereskedo-listaban: %s" % ", ".join(leaked)) if leaked else "futarok kizarva"


# ---- group: ui (a v4.2-n KIVULI, owner-jovahagyott UI-munka) ----
# Istvan 2026-08-09: "ez a funkcio bar nem volt benne az eredeti speckoban".
# Pontosan ezert kell ide: aminek nincs kriteriuma, az nem tud elkeszulni a kapu
# ertelmeben, es ugyanugy elsodrodik, mint amit az audit talalt. A spec-en kivuli,
# de tulajdonos altal jovahagyott munka ugyanazt a merest kapja.

@crit("UI-1", "ui", "kartya 9193eedd", "az ugy-tovabblepteto vezerlok elnek a kartyakon")
def _ui1():
    absent, detail = absent_in_prod("owner-action", "web")
    if absent is None:
        return ERROR, detail
    return (FAIL if absent else PASS), detail


@crit("UI-2", "ui", "kartya 36ba14a5", "a valaszlehetosegek a KERDESBOL szarmaznak, nem generikus igen/nem")
def _ui2():
    # Az elso valtozat HAMIS ZOLDET adott: az `answer_options` mintara ratalalt a
    # schedules.ts-ben egy teljesen mas celu mezore, es keszen jelentette azt ami
    # meg el sem kezdodott. Egy szeles minta az EGESZ src/-ben nem kepesseget mer,
    # hanem szoegyezest. A kriterium most a KIMENETET nezi: eltunt-e a bedrotozott
    # igen/nem a feluletrol, es van-e helyette kerdesbol szarmazo keszlet.
    ui = os.path.join(REPO, "web", "coscontrol.js")
    if not os.path.exists(ui):
        return ERROR, "web/coscontrol.js nem található"
    try:
        body = open(ui, encoding="utf-8", errors="replace").read()
    except OSError as e:
        return ERROR, str(e)
    hardcoded = 'value="YES"' in body or "value='YES'" in body
    derived = any(k in body for k in ("answerOptions", "answer_options", "optionsFromQuestion"))
    if hardcoded and not derived:
        return FAIL, "a felület még a bedrótozott Igen/Nem rádiót rendereli"
    if not derived:
        return FAIL, "nincs kérdésből származó válaszkészlet a felületen"
    return PASS, "kérdésből származó válaszkészlet, bedrótozott igen/nem nélkül"


@crit("UI-3", "ui", "kartya 78e81155", "a szoveges valasz ertelmezese a VALASZ pillanataban tortenik, javaslatkent")
def _ui3():
    absent, detail = absent_in_prod("interpretAnswer\\|answer_interpretation\\|valasz_ertelmezes", None)
    if absent is None:
        return ERROR, detail
    return (FAIL if absent else PASS), ("nincs valasz-ertelmezo javaslat-ut" if absent else detail)


# ---- group: testing ----

@crit("TS-1", "testing", "audit 2026-08-09 G7", "van végpontok közötti teszt a valódi bejövő láncra")
def _ts1():
    tdir = os.path.join(SRC, "__tests__")
    if not os.path.isdir(tdir):
        return ERROR, "nincs teszt könyvtár"
    try:
        out = subprocess.run(["grep", "-rl", "email-triage-fetch\\|triageOutputShape\\|realFeederShape", tdir],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception as e:
        return ERROR, str(e)
    files = out.split()
    return (PASS if files else FAIL), (", ".join(os.path.basename(f) for f in files) or "nincs olyan teszt, ami a valódi levélszedő kimeneti formáját hajtaná át a láncon")


# --- runner ------------------------------------------------------------------

GROUP_ORDER = ["intake", "scope", "approval", "outbound", "liveness", "scheduler",
               "monitoring", "migration", "workflow", "linking", "ui", "testing"]
GROUP_LABEL = {
    "intake": "Bejövő lánc (§6.3, §8)",
    "scope": "Hatókör (§2, AC-17)",
    "approval": "Jóváhagyási boríték (§3)",
    "outbound": "Kimenő (§6.2, §7, §15)",
    "liveness": "Élő hívó és tényleges működés",
    "scheduler": "Ütemezés (§14)",
    "monitoring": "Monitorozás (§19)",
    "migration": "Migráció (§17)",
    "workflow": "Workflow és autonómia (§13, §21, §22)",
    "linking": "Ügy-összekötés (spec-en kívüli, owner-jóváhagyott)",
    "ui": "Mission Control válaszút (spec-en kívüli, owner-jóváhagyott)",
    "testing": "Tesztfedés",
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

    print("COS acceptance gate — %d kritérium" % len(results))
    print("PASS %d   FAIL %d   UNKNOWN %d   ERROR %d" %
          (counts[PASS], counts[FAIL], counts[UNKNOWN], counts[ERROR]))
    print("KAPU: %s" % ("ZOLD" if green else "PIROS — az UNKNOWN nem PASS (APG 1.8 §3.7)"))
    for g in GROUP_ORDER:
        rows = [r for r in results if r["group"] == g]
        if not rows:
            continue
        print("\n%s" % GROUP_LABEL.get(g, g))
        for r in rows:
            print("  [%s] %-6s %-8s %s" % (MARK[r["status"]], r["id"], r["ref"], r["title"]))
            print("            %s" % r["evidence"])
    return 0 if green else 1


if __name__ == "__main__":
    sys.exit(main())
