#!/usr/bin/env python3
"""Fetch recent mail from both Google accounts via the local stdio MCP servers,
drop high-confidence noise deterministically, and dedup against previously
reported message ids. Prints a compact JSON candidate list for LLM judgement.

Stdlib only. Never prints credentials. Read-only.

Usage: python3 scripts/email-triage-fetch.py [--window 4d] [--mark id1,id2,...]
  --mark  record ids as reported (called AFTER a Telegram notification goes out)
"""
import hashlib, json, subprocess, sys, os, re, time

REPO = os.environ.get("MARVEEN_REPO_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(REPO, "store", "email-triage-state.json")
SERVERS = {
    "private": os.path.join(REPO, "mcp-servers", "google-private-mcp.py"),
    "zst": os.path.join(REPO, "mcp-servers", "google-zst-mcp.py"),
}

# Sender substrings that SUGGEST noise. A sender match alone is NEVER a drop
# reason (2026-08-09): most real transactional mail (courier, webshop, airline,
# bank, cloud provider) is sent from a machine address, so the technical sender
# says nothing about whether the content matters. A sender match only drops when
# the subject/snippet is not transactional -- see is_noise().
NOISE_SENDERS = [
    "no-reply@accounts.google.com", "noreply-accounts@google.com",
    "marketing@", "newsletter", "no-reply@", "noreply@", "donotreply@",
    "posthog.com", "hellonancy.com",
    "ft.com", "otpbank", "globalmarkets", "ikea", "ecipo", "biggeorge",
    "lindy.ai", "telekom", "mailchimp", "sendgrid", "substack",
    # bulk/marketing sender shapes (HU newsletters use these heavily)
    "news@", "napi@", "hirlevel", "promo@", "offers@", "shop@", "store@",
    "@my.", "@news.", "@lc.", "ajanlo.", "temu", "info@info.",
    "noreply-", "dmarc", "@bk.", "bizalomkartya",
]
# OWN traffic: our own products and test harnesses mailing us. These are noise
# by ORIGIN, and the origin outranks the words -- a QuickQuote test quote reads
# exactly like a real quote request, which is how the 2026-08-17 retrospective
# sweep first reported Istvan's own test traffic as "open quote threads". The
# exclusion lives HERE, in the normative filter the live heartbeat runs, not in
# the sweep: a rule that only exists in the analysis tool protects the analysis
# and nothing else.
OWN_TRAFFIC_SENDERS = [
    "no-reply@mail.zstradio.com", "ajanlat@mondigo.eu", "hello@vidamo.eu",
    "@quickquote.", "quickquote@",
]
OWN_TRAFFIC_SUBJECTS = ["[teszt]", "[test]", "complaint test", "webhook test"]

NOISE_SUBJECTS = [
    "sale", "% off", "welcome to", "verify your email", "confirm your email",
    "unsubscribe", "newsletter", "webinar", "black friday", "deal",
    "security alert", "biztonsagi ertesites", "new sign-in", "uj bejelentkezes",
    # HU marketing (accent-normalised before matching)
    "kedvezmeny", "akcio", "utalvany", "nyer", "sorsol", "last minute",
    "felaron", "ingyen", "meglepetes", "learazas", "kupon", "ajandek",
    "hirlevel", "nyaralni megy",
]
# Never drop these, regardless of the noise rules above.
ALWAYS_KEEP = [
    "tarhely.gov.hu", "nav.gov.hu", "@nav.", "dap.gov", "digitalis allampolgar", "ugyfelkapu",
    "barion", "invoice", "szamla", "fizetesi", "felszolitas", "hatarido",
    "arajanlat", "foglalas", "visszaigazolas", "szerzodes", "megrendeles",
]
# Transactional content markers. These OVERRIDE a NOISE_SENDERS match (but not a
# NOISE_SUBJECTS match): a machine sender carrying transactional content is the
# normal shape of a courier/order/credit confirmation, not noise.
TRANSACTIONAL = [
    # HU -- logistics / order / money
    "csomag", "szallit", "kiszallit", "futar", "csomagpont", "atvevo", "atvetel",
    "nyomkovet", "rendeles", "megrendel", "visszakuld", "visszaru", "reklamacio",
    "garancia", "csereutalvany", "utalas", "fizetes", "befizet", "szamla",
    "jegy", "beszallas", "utazas", "jarat", "azonosito", "ugyszam", "iktat",
    "igenyles", "palyazat", "jovahagy", "elutasit", "elfogadva", "lejar",
    "hatarido", "szerzodes", "felmond", "elomerite", "keszen all",
    # EN -- logistics / order / money
    "order", "shipment", "shipping", "delivery", "dispatch", "parcel", "waybill",
    "tracking", "pickup", "return label", "collection", "courier",
    "invoice", "receipt", "payment", "refund", "statement",
    "booking", "reservation", "itinerary", "boarding", "check-in",
    # EN -- account / application lifecycle (cloud credits, programs)
    "application", "your request", "next steps", "action required", "activate",
    "activation", "credits", "credit program", "approved", "accepted",
    "under review", "case ", "ticket ", "contract", "renewal", "expires",
]

# Egyertelmu promocios jelolok. Ezek NEM dobasi okok onmagukban -- csak azt
# tiltjak, hogy a tranzakcios felulbiralas kimentsen egy zaj-feladot.
PROMO_MARKERS = [
    "last minute", "felaron", "fel aron", "kedvezmeny", "akcio", "learazas",
    "% off", "kupon", "utalvany", "black friday", "csak ma", "meglepetes ar",
]

_ACC = str.maketrans("áéíóöőúüűÁÉÍÓÖŐÚÜŰ", "aeiooouuuAEIOOOUUU")


def _norm(s):
    return (s or "").translate(_ACC).lower()


def call_mcp(server_path, query, max_results=25):
    """One-shot stdio JSON-RPC against a google-*-mcp.py server."""
    req = (
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "triage", "version": "1"}}}) + "\n" +
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "gmail_search",
            "arguments": {"query": query, "max_results": max_results}}}) + "\n"
    )
    try:
        p = subprocess.run([sys.executable, server_path], input=req,
                           capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        return [], "timeout"
    msgs = []
    for line in p.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("id") != 2:
            continue
        res = d.get("result", {})
        if res.get("isError"):
            return [], "server_error"
        for c in res.get("content", []):
            try:
                msgs = json.loads(c.get("text", "[]"))
            except ValueError:
                pass
    return (msgs if isinstance(msgs, list) else []), None


# ── GitHub notifications: SENDER != RELEVANCE ────────────────────────────────
#
# `notifications@github.com` sat in NOISE_SENDERS until 2026-09-06, so every
# GitHub mail was dropped before anything read it: maintainer comments, merge
# conflicts, failing required checks and secret-scanning alerts on our OWN pull
# requests, for weeks. Istvan named the invariant when it surfaced: SENDER !=
# RELEVANCE. He also ruled out the obvious replacement rule -- "human vs bot" is
# the same mistake wearing a different dimension, because the mail that matters
# most here is machine-sent BY DEFINITION. A failing required check has no human
# author and is the single most actionable thing GitHub sends us.
#
# So the decision is made on the EVENT and its ACTIONABILITY, never on who sent
# it. Two classes are unconditional keeps: a failing check and a security alert.
GITHUB_SENDERS = ["notifications@github.com", "noreply@github.com", "@github.com"]

# Live verifications per run. A heartbeat that woke up to forty notifications
# must not answer with forty API calls; beyond the cap the candidate still
# surfaces, saying plainly that it was not verified.
GH_VERIFY_MAX = 12

# Unconditional keeps. These outrank everything, including a promo-looking
# subject, because a bot is supposed to be the one saying them.
GITHUB_MUST_SURFACE = [
    "some checks were not successful", "all checks have failed",
    "check failure", "checks have failed", "workflow run failed",
    "run failed", "build failed", "failing after",
    "secret scanning", "secret detected", "exposed secret",
    "security alert", "security advisory", "dependabot alert",
    "vulnerability", "code scanning alert",
    "required status check", "required check",
]

# Actionable, but ordinary: something happened that a person may need to answer.
GITHUB_ACTIONABLE = [
    "requested your review", "review requested", "requested changes",
    "approved these changes", "commented on", "left a comment",
    "mentioned you", "assigned you", "asked you",
    "has conflicts", "merge conflict", "cannot be merged",
    "reopened", "closed this", "merged", "ready for review",
    "new comment", "replied", "pushed", "force-pushed",
]

# Genuinely nothing to do. Kept SHORT on purpose: an unrecognised GitHub event
# is surfaced, not dropped. Absence of evidence that it matters is not evidence
# that it does not.
GITHUB_NOISE = [
    "starred your repository", "started following you",
    "is now following", "your weekly digest", "trending repositories",
    "newsletter", "github explore",
]

_GH_REPO = re.compile(r"\[([\w.-]+/[\w.-]+)\]")
# ONLY the parenthesised form identifies a pull request or issue. A bare "#4" in
# a GitHub subject is very often something else entirely -- "Secret scanning
# alert #4" is alert four, not PR four -- and verifying it as a PR would fetch
# an UNRELATED pull request and attach its state to this mail. That is not a
# missing check, it is a wrong answer wearing a check's clothes, which is worse.
_GH_PR = re.compile(r"\((?:PR|Pull Request) #(\d+)\)", re.I)
_GH_ISSUE = re.compile(r"\((?:Issue) #(\d+)\)", re.I)


def github_event(m):
    """Classify a GitHub notification. Returns None when it is not one.

    The verdict is (kind, actionable) and NEVER depends on the sender being a
    bot. `unknown` is actionable: a GitHub event we do not recognise is more
    likely to be something new than something worthless.
    """
    frm = _norm(m.get("from"))
    if not any(g in frm for g in GITHUB_SENDERS):
        return None
    text = _norm(m.get("subject")) + " " + _norm(m.get("snippet"))
    subject_raw = m.get("subject") or ""
    repo_hit = _GH_REPO.search(subject_raw)
    repo = repo_hit.group(1) if repo_hit else None
    pr_hit = _GH_PR.search(subject_raw)
    issue_hit = _GH_ISSUE.search(subject_raw)
    number = pr_hit.group(1) if pr_hit else (issue_hit.group(1) if issue_hit else None)
    number_kind = "pull" if pr_hit else ("issue" if issue_hit else None)
    if any(k in text for k in GITHUB_MUST_SURFACE):
        return {"kind": "check_or_security_failure", "actionable": True,
                "repo": repo, "number": number, "numberKind": number_kind, "mustSurface": True}
    if any(k in text for k in GITHUB_ACTIONABLE):
        return {"kind": "activity", "actionable": True,
                "repo": repo, "number": number, "numberKind": number_kind, "mustSurface": False}
    if any(k in text for k in GITHUB_NOISE):
        return {"kind": "social", "actionable": False,
                "repo": repo, "number": number, "numberKind": number_kind, "mustSurface": False}
    return {"kind": "unknown", "actionable": True,
            "repo": repo, "number": number, "numberKind": number_kind, "mustSurface": False}


def github_current_state(repo, number, timeout=20):
    """What the PR looks like NOW, not what the mail said when it was sent.

    An email is a snapshot of a moment that has usually passed: a conflict may
    be resolved, a red check may be green, a PR may be merged. Acting on the
    mail alone is how a stale message becomes a wrong action -- which has cost
    us real work before. Read-only, and FAIL-SOFT: no `gh`, no network, no auth
    and the candidate still surfaces, carrying the reason the check could not be
    made. A verification we could not perform must never read as "verified".
    """
    if not repo or not number:
        return {"checked": False, "why": "the mail names no repo/number to verify"}
    try:
        p = subprocess.run(
            ["gh", "api", "repos/%s/pulls/%s" % (repo, number),
             "--jq", '{state,draft,mergeable,mergeable_state,merged,head:.head.sha}'],
            capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"checked": False, "why": "gh unavailable or timed out (%s)" % type(e).__name__}
    if p.returncode != 0:
        return {"checked": False, "why": "gh exit %d" % p.returncode}
    try:
        return {"checked": True, "pr": json.loads(p.stdout.strip() or "{}")}
    except ValueError:
        return {"checked": False, "why": "gh returned unparseable JSON"}


def is_noise(m):
    frm = _norm(m.get("from"))
    subj = _norm(m.get("subject"))
    snip = _norm(m.get("snippet"))
    # Origin first: our own product/test mail is noise whatever it says, and it
    # must be decided BEFORE the transactional override, which would otherwise
    # rescue a test invoice for looking like an invoice.
    if any(x in frm for x in OWN_TRAFFIC_SENDERS) or any(x in subj for x in OWN_TRAFFIC_SUBJECTS):
        return True
    # GitHub is decided on the EVENT, before any sender or subject rule can
    # touch it. Note the ordering: this sits ABOVE the NOISE_SUBJECTS check, so
    # a failing check cannot be dropped for a subject word, and above
    # ALWAYS_KEEP, so the two lists cannot silently disagree about it.
    gh = github_event(m)
    if gh is not None:
        return not gh["actionable"]
    if any(k in frm + " " + subj + " " + snip for k in ALWAYS_KEEP):
        return False
    # Marketing shapes in the SUBJECT still drop, whoever sent them.
    if any(s in subj for s in NOISE_SUBJECTS):
        return True
    if any(s in frm for s in NOISE_SENDERS):
        # Sender alone is not a drop reason: rescue anything whose subject or
        # body reads transactional (GLS parcel, AWS Activate, order receipts).
        # BUT a promo body disables the rescue (2026-08-09, elesben): a szinhazi
        # hirlevel atcsuszott, mert a torzseben ott volt a "jegyek" szo. A
        # tranzakcios szavak egy resze (jegy, utazas) minden reklamban ott van;
        # ezert ha a torzs egyertelmuen promocios, a felulbiralas NEM sul el.
        # Szandekosan NEM dobjuk el a levelet a torzs alapjan -- egy valodi
        # visszaigazolasban is szerepelhet az "ingyenes szallitas".
        if any(p in subj + " " + snip for p in PROMO_MARKERS):
            return True
        if any(t in subj + " " + snip for t in TRANSACTIONAL):
            return False
        return True
    return False


SELFTEST = [
    # (should_be_noise, message) -- the first four are the 2026-08-09 misses.
    (False, {"from": "noreply@gls-group.eu", "subject": "GLS csomagfeladas visszaigazolas",
             "snippet": "A csomagszam: 12345. A futar erkezik."}),
    (False, {"from": "no-reply@startups.aws", "subject": "Your AWS Activate application",
             "snippet": "We received your application. Next steps below."}),
    (False, {"from": "noreply@oracle-cloud.com", "subject": "Your Oracle Cloud account is ready",
             "snippet": "Trial credits have been applied to your account."}),
    (False, {"from": "no-reply@wizzair.com", "subject": "Booking confirmation",
             "snippet": "Your itinerary and invoice are attached."}),
    # ...and these must STILL be dropped, or the fix is just an off switch.
    (True, {"from": "newsletter@temu.com", "subject": "50% kedvezmeny ma",
            "snippet": "Akcio minden termekre."}),
    (True, {"from": "noreply@shop.example.com", "subject": "Learazas: last minute deal",
            "snippet": "Rendeles most, szallitas ingyen."}),
    (True, {"from": "no-reply@accounts.google.com", "subject": "Security alert",
            "snippet": "New sign-in on your device."}),
    (True, {"from": "marketing@hellonancy.com", "subject": "Weekly digest",
            "snippet": "Read what happened this week."}),
    # 2026-08-09 elesben atcsuszott: a "jegyek" szo mentette ki a szinhazi
    # hirlevelet. A promo-jelolo ("last minute", "felaron") most letiltja ezt.
    (True, {"from": "napi@ajanlo.ma", "subject": "Hetfo Augusztus 10. Dumaszinhaz",
            "snippet": "Ma este Szinhaz! Last minute jegyek, felaron 2026.08.10"}),
    # ── SENDER != RELEVANCE (2026-09-06) ─────────────────────────────────────
    # notifications@github.com was a hard drop, so none of these ever reached
    # triage. Every keep below is machine-sent, which is the point: the rule is
    # about the EVENT, not about whether a human typed it.
    (False, {"from": "notifications@github.com",
             "subject": "Re: [Szotasz/marveen] feat(monitor): memory-pressure monitor (PR #775)",
             "snippet": "Some checks were not successful: secret-gate / scan failed."}),
    (False, {"from": "notifications@github.com",
             "subject": "[Szotasz/marveen] Secret scanning alert #4",
             "snippet": "A secret was detected in a commit on this repository."}),
    (False, {"from": "notifications@github.com",
             "subject": "Re: [Szotasz/marveen] feat(costops): provider collectors (PR #628)",
             "snippet": "Szotasz commented on this pull request: kerlek rebase-eld a develop-ra."}),
    (False, {"from": "notifications@github.com",
             "subject": "Re: [Szotasz/marveen] CostOps monitoring (PR #660)",
             "snippet": "This branch has conflicts that must be resolved."}),
    (False, {"from": "notifications@github.com",
             "subject": "[Szotasz/marveen] Run failed: test - develop (32651890365)",
             "snippet": "The workflow run failed."}),
    # An unrecognised GitHub event is SURFACED, not dropped: absence of a known
    # keyword is not evidence that nothing happened.
    (False, {"from": "notifications@github.com",
             "subject": "[Szotasz/marveen] Something new we have not seen before (#900)",
             "snippet": "No keyword in here matches any list."}),
    # ...and the genuinely empty social traffic still goes.
    (True, {"from": "notifications@github.com",
            "subject": "[GitHub] someone starred your repository",
            "snippet": "somebody starred your repository marveen."}),
    (True, {"from": "notifications@github.com",
            "subject": "Your weekly digest",
            "snippet": "Trending repositories you might like."}),
    # A promo-shaped SUBJECT must not be able to bury a failing check: the
    # GitHub rule is consulted before NOISE_SUBJECTS.
    (False, {"from": "notifications@github.com",
             "subject": "[Szotasz/marveen] Sale of the week (PR #775)",
             "snippet": "Some checks were not successful."}),
]


def _selftest_trim():
    """Drive the eviction bug red.

    The old implementation was `list(ids)[-500:]` over a SET, so at the cap it
    dropped twelve arbitrary ids instead of the twelve oldest -- and a mail
    marked seen minutes earlier came back as a fresh candidate. Note which
    assertion catches it: "everything just marked survives" is the SYMPTOM, and
    it is the one the old code passes by luck about half the time, because which
    ids the hash layout drops is arbitrary. The two below it are about the
    MECHANISM and fail every run.
    """
    fails = []
    previous = ["old%03d" % i for i in range(500)]
    fresh = ["new%02d" % i for i in range(10)]
    ids = set(previous) | set(fresh)
    keep = trim_reported(previous, ids)
    if len(keep) != 500:
        fails.append("cap not honoured: %d" % len(keep))
    missing = [i for i in fresh if i not in keep]
    if missing:
        fails.append("just-marked ids evicted: %s" % ",".join(missing))
    if keep[:3] != ["old010", "old011", "old012"]:
        fails.append("the head that was dropped was not the oldest: %s" % keep[:3])
    if trim_reported(keep, set(keep)) != keep:
        fails.append("a no-op save reordered the file")
    return fails


# What a GitHub subject actually REFERS to. Written after the first version of
# this classifier read "Secret scanning alert #4" as pull request four and would
# have fetched an unrelated PR's state to attach to a security alert. A wrong
# answer wearing a verified badge is worse than no answer.
GH_REF_SELFTEST = [
    ("Re: [Szotasz/marveen] feat(monitor): the monitor (PR #775)", "Szotasz/marveen", "775", "pull"),
    ("Re: [Szotasz/marveen] a bug report (Issue #900)", "Szotasz/marveen", "900", "issue"),
    ("[Szotasz/marveen] Secret scanning alert #4", "Szotasz/marveen", None, None),
    ("[Szotasz/marveen] Run failed: test - develop (32651890365)", "Szotasz/marveen", None, None),
    ("Your weekly digest", None, None, None),
]


def _selftest_github_refs():
    fails = []
    for subj, repo, num, kind in GH_REF_SELFTEST:
        got = github_event({"from": "notifications@github.com", "subject": subj, "snippet": ""})
        if got is None:
            fails.append("no event for %r" % subj)
            continue
        if (got["repo"], got["number"], got["numberKind"]) != (repo, num, kind):
            fails.append("%r -> repo=%s number=%s kind=%s (want %s/%s/%s)"
                         % (subj, got["repo"], got["number"], got["numberKind"], repo, num, kind))
    # An unverifiable reference must say so rather than claim a check.
    st = github_current_state(None, None)
    if st.get("checked") is not False:
        fails.append("a missing repo/number must report checked=False")
    return fails


def selftest():
    bad = [(want, m) for want, m in SELFTEST if is_noise(m) != want]
    for want, m in bad:
        print("FAIL want_noise=%s got=%s :: %s | %s" % (want, not want, m["from"], m["subject"]))
    trim_fails = _selftest_trim()
    for f in trim_fails:
        print("FAIL trim :: %s" % f)
    gh_fails = _selftest_github_refs()
    for f in gh_fails:
        print("FAIL github-ref :: %s" % f)
    failed = len(bad) + len(trim_fails) + len(gh_fails)
    print(json.dumps({"selftest": "FAIL" if failed else "PASS",
                      "cases": len(SELFTEST) + 1 + len(GH_REF_SELFTEST), "failed": failed}))
    sys.exit(1 if failed else 0)


def load_state():
    try:
        with open(STATE) as f:
            d = json.load(f)
            return set(d.get("reported_ids", [])), d
    except Exception:
        return set(), {}


REPORTED_CAP = 500


def trim_reported(previous, ids, cap=REPORTED_CAP):
    """The order-preserving trim. Split out from save_state so it can be tested.

    `previous` is the list as it was written last time (ordered); `ids` is the
    current set. Ids that survive keep their position, newly marked ones go on
    the end, and only then is the head dropped -- so the trim removes the OLDEST,
    which is what its name has always claimed.
    """
    kept = [i for i in previous if i in ids]
    seen_kept = set(kept)
    fresh = sorted(i for i in ids if i not in seen_kept)
    return (kept + fresh)[-cap:]


def save_state(ids, prev):
    """Persist the seen-set, keeping the MOST RECENT 500 ids.

    THE BUG THIS FIXES, found live 2026-08-27. `ids` is a SET, and the old line
    was `keep = list(ids)[-500:]`. A set has no order -- its iteration order is
    the hash layout -- so once the file reached the 500 cap, every mark evicted
    twelve ARBITRARY ids rather than the twelve oldest. Measured: a ChatGPT task
    notification marked at 22:14 came back as an unseen candidate at 23:01, and
    the id was gone from the file.

    What that costs is quiet and cumulative. A resurfaced mail is triaged again
    from scratch, so a settled thread can reopen as a Telegram report hours after
    it was dealt with. The intake is idempotent per (account, message), so the
    case store is protected -- but the judgement, the noise and the owner's
    attention are not, and "the store did not corrupt" is not the same as "the
    system worked".

    The order lives in the FILE, not in the set: previous ids keep their
    position, newly marked ones go on the end, and the trim finally means what
    its own comment always claimed.
    """
    prev = prev or {}
    prev["reported_ids"] = trim_reported(prev.get("reported_ids", []), ids)
    prev["last_run_at"] = int(time.time())
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(prev, f)


# --- Stage 2G provenance -----------------------------------------------------

SOURCE_MANIFEST_FIELDS = ("account", "id", "threadId", "direction", "from", "subject", "date", "snippet", "to")


def _source_manifest_hash(cand: dict) -> str:
    """Canonical fingerprint of one triage input.

    Canonical means order- and formatting-independent: the same letter always
    hashes the same way, and a changed snippet changes the hash. A receipt that
    carried a looser digest (a corpus hash, a message id) would say WHICH mail
    was judged but not WHAT the judge could see, and the difference matters the
    day a body is truncated or re-fetched differently.
    """
    payload = {k: cand.get(k) for k in SOURCE_MANIFEST_FIELDS if cand.get(k) is not None}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


CANONICAL_MODEL_ID_RE = re.compile(
    r"^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*(?:/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)*$")
MODEL_VARIANT_RE = re.compile(r"^\[[a-z0-9]{1,16}\]$")
MODEL_IDENTITY_UNRESOLVED = "MODEL_IDENTITY_UNRESOLVED"


def _read_proc(pid):
    """One process, as raw as the OS will give it. None if unreadable."""
    try:
        with open("/proc/%d/comm" % pid, "rb") as fh:
            comm = fh.read().decode("utf-8", "replace").rstrip("\n")
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
        with open("/proc/%d/stat" % pid, "rb") as fh:
            stat = fh.read().decode("utf-8", "replace")
    except OSError:
        return None
    argv = raw.split("\0")
    if argv and argv[-1] == "":
        argv.pop()
    # stat field 2 is "(comm)" and may itself contain spaces and parentheses, so
    # fields are counted from after the LAST ')'. ppid is field 4.
    ppid = None
    close = stat.rfind(")")
    if close != -1:
        after = stat[close + 1:].split()
        if len(after) > 1 and after[1].isdigit():
            ppid = int(after[1])
    try:
        exe = os.readlink("/proc/%d/exe" % pid)
    except OSError:
        exe = None
    return {"pid": pid, "ppid": ppid, "comm": comm, "argv": argv, "exe": exe}


def _has_control_chars(s: str) -> bool:
    for ch in s:
        c = ord(ch)
        if c < 0x20 or c == 0x7F or 0x80 <= c <= 0x9F:
            return True
    return False


def _validate_model_id(raw: str):
    """Validate and DECOMPOSE. Returns (ok, payload_or_reason, detail)."""
    if _has_control_chars(raw):
        return (False, "MODEL_IDENTITY_CONTROL_CHARACTERS",
                "control/ANSI bytes; rejected as read, never stripped")
    if not raw:
        return (False, "MODEL_IDENTITY_NOT_CANONICAL", "empty value")
    if len(raw) > 128:
        return (False, "MODEL_IDENTITY_NOT_CANONICAL", "length %d exceeds 128" % len(raw))
    base, variant = raw, None
    if raw.endswith("]"):
        open_at = raw.rfind("[")
        if open_at <= 0:
            return (False, "MODEL_IDENTITY_NOT_CANONICAL",
                    'a trailing "]" with no opening bracket, or an empty base id')
        suffix = raw[open_at:]
        if not MODEL_VARIANT_RE.match(suffix):
            return (False, "MODEL_IDENTITY_NOT_CANONICAL",
                    "trailing suffix %r is not a declared variant; rejected, not removed" % suffix)
        base, variant = raw[:open_at], suffix[1:-1]
    if not CANONICAL_MODEL_ID_RE.match(base):
        return (False, "MODEL_IDENTITY_NOT_CANONICAL",
                "base id does not match the canonical grammar; nothing is removed to make it fit")
    return (True, {"modelId": raw, "model": base, "modelVariant": variant}, None)


def _resolve_runtime_model_identity(start_pid=None):
    """The model identity of the claude process running us, from RAW argv.

    This lives HERE, in the file the pinned release already carries, so the
    heartbeat has exactly ONE implementation on its runtime path. The SKILL then
    passes the value through verbatim like the other fingerprints, instead of
    carrying a prose copy of these rules that would drift the first time either
    side is edited.

    Rules, all load-bearing (Istvan, 2026-08-23/24):
      - /proc/<pid>/cmdline, NUL-separated: raw argv, never a `ps` rendering;
      - the NEAREST claude ancestor is the only authority. A non-claude ancestor's
        --model is not weighed and rejected, it is never read; and if the nearest
        claude carries no --model, the answer is UNRESOLVED rather than a value
        borrowed from an outer session;
      - nothing is cleaned. A decorated value fails; it is not repaired. A
        resolver that silently strips a character reports a model no process was
        launched with;
      - `[1m]` and friends are DECOMPOSED, not discarded: the recorded id stays
        the raw string, with the base and the variant reported alongside.
    """
    pid = os.getpid() if start_pid is None else start_pid
    walked, seen = [], set()
    for _ in range(64):
        if pid is None or pid <= 1 or pid in seen:
            break
        seen.add(pid)
        p = _read_proc(pid)
        if p is None:
            break
        argv0 = p["argv"][0] if p["argv"] else ""
        is_claude = p["comm"] == "claude" and os.path.basename(argv0) == "claude"
        walked.append({"pid": p["pid"], "comm": p["comm"], "argv0": argv0, "isClaude": is_claude})
        if not is_claude:
            pid = p["ppid"]
            continue

        found = None
        for i, a in enumerate(p["argv"]):
            if a == "--model" and i + 1 < len(p["argv"]):
                found = (p["argv"][i + 1], i, "separate")
                break
            if a.startswith("--model="):
                found = (a[len("--model="):], i, "inline")
                break
        if found is None:
            return {"ok": False, "triageModel": MODEL_IDENTITY_UNRESOLVED,
                    "reason": MODEL_IDENTITY_UNRESOLVED,
                    "detail": "the nearest claude ancestor (pid %d) carries no --model" % p["pid"],
                    "raw": None, "walked": walked, "source": None}
        raw, idx, form = found
        source = {"pid": p["pid"], "path": "/proc/%d/cmdline" % p["pid"],
                  "argv0": argv0, "exe": p["exe"], "argvIndex": idx, "form": form}
        ok, payload, detail = _validate_model_id(raw)
        if not ok:
            return {"ok": False, "triageModel": MODEL_IDENTITY_UNRESOLVED,
                    "reason": payload, "detail": detail,
                    "raw": raw, "walked": walked, "source": source}
        return {"ok": True, "triageModel": payload["modelId"],
                "model": payload["model"], "modelVariant": payload["modelVariant"],
                "reason": None, "detail": None,
                "raw": raw, "walked": walked, "source": source}

    return {"ok": False, "triageModel": MODEL_IDENTITY_UNRESOLVED,
            "reason": MODEL_IDENTITY_UNRESOLVED,
            "detail": "no claude process among the ancestors",
            "raw": None, "walked": walked, "source": None}


def _prompt_fingerprint() -> str:
    """Fingerprint of the RULES this triage runs under, read from disk.

    A hand-written version string is a promise; this is a measurement. If the
    heartbeat's SKILL.md or the triage skill changes by one character, the
    fingerprint moves, and every receipt written afterwards says so.
    """
    parts = []
    for path in (
        os.path.expanduser("~/.claude/scheduled-tasks/personal-gmail-delta/SKILL.md"),
        os.path.expanduser("~/.claude/skills/gmail-personal-action-triage/SKILL.md"),
        os.path.abspath(__file__),
    ):
        try:
            with open(path, "rb") as fh:
                parts.append(f"{os.path.basename(path)}:{hashlib.sha256(fh.read()).hexdigest()}")
        except OSError:
            parts.append(f"{os.path.basename(path)}:MISSING")
    return "rules:" + hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


def main():
    args = sys.argv[1:]
    if "--selftest" in args:
        selftest()
        return
    if "--mark" in args:
        new = args[args.index("--mark") + 1].split(",")
        seen, prev = load_state()
        seen.update(i.strip() for i in new if i.strip())
        save_state(seen, prev)
        print(json.dumps({"marked": len(new)}))
        return

    window = "4d"
    if "--window" in args:
        window = args[args.index("--window") + 1]

    seen, prev = load_state()
    first_run = not seen and not prev
    out = {"first_run": first_run, "accounts": {}, "candidates": [], "errors": []}
    # One live lookup per PR per run, capped: the triage runs on a heartbeat and
    # must not turn a mailbox full of notifications into a burst of API calls.
    gh_state_cache = {}

    for name, path in SERVERS.items():
        if not os.path.exists(path):
            out["accounts"][name] = "server_missing"
            out["errors"].append({"account": name, "problem": "server_missing",
                                  "meaning": "A fiok NEM lett ellenorizve."})
            continue
        # Query BOTH the inbox (INBOUND) and the Sent folder (OUTBOUND). His own
        # sent mail becomes OUTBOUND candidates -> COS makes WAITING_EXTERNAL cases
        # with a follow-up (watching whether a reply comes). The COS intake still
        # filters our OWN automated sends via the X-Marveen idempotency marker, so
        # surfacing Sent here cannot create a self-reply loop.
        kept = 0
        total = 0
        errored = False
        for direction, q in (("INBOUND", f"in:inbox newer_than:{window}"),
                             ("OUTBOUND", f"in:sent newer_than:{window}")):
            msgs, err = call_mcp(path, q)
            if err:
                out["accounts"][name] = err
                hint = ("A refresh_token valoszinuleg lejart/visszavonva -> Istvan bongeszos "
                        "consentje kell (lasd google-workspace-readonly-mcp-wire skill re-auth szekcio)."
                        if err == "server_error" else "")
                out["errors"].append({"account": name, "problem": err,
                                      "meaning": "A fiok NEM lett ellenorizve -- a 0 jelolt NEM jelenti azt hogy nincs teendo.",
                                      "hint": hint, "query": direction})
                errored = True
                break
            total += len(msgs)
            for m in msgs:
                mid = m.get("id")
                if not mid or mid in seen:
                    continue
                # Noise-filter only INBOUND (newsletters/promos/dmarc). Sent mail is
                # from Istvan himself, so the sender-based noise filter never applies;
                # actionability of his own sends is judged in the triage step.
                if direction == "INBOUND" and is_noise(m):
                    continue
                kept += 1
                cand = {
                    "account": name, "id": mid, "threadId": m.get("threadId"),
                    "direction": direction,
                    "from": m.get("from"), "subject": m.get("subject"),
                    "date": m.get("date"), "snippet": (m.get("snippet") or "")[:300],
                }
                if direction == "OUTBOUND":
                    # recipient of his sent mail (may be absent if the MCP omits it;
                    # then the triage fills it after gmail_read)
                    cand["to"] = m.get("to")
                # Stage 2G (2026-08-17): the canonical hash of EXACTLY what the
                # triaging agent will see. Not a corpus-wide digest and not the
                # raw mailbox: the fields below ARE the decision's input, so the
                # receipt can later prove what was judged, not merely when.
                # GitHub: attach the event class AND what the PR looks like
                # NOW. The mail is a snapshot of a moment that has usually
                # passed -- a conflict may be resolved, a red check green, the
                # PR merged. Reading the mail alone is how a stale message
                # becomes a wrong action.
                gh = github_event(m) if direction == "INBOUND" else None
                if gh:
                    cand["github"] = gh
                    if gh["actionable"] and gh.get("repo") and gh.get("numberKind") == "pull":
                        key = "%s#%s" % (gh["repo"], gh["number"])
                        if key not in gh_state_cache and len(gh_state_cache) < GH_VERIFY_MAX:
                            gh_state_cache[key] = github_current_state(gh["repo"], gh["number"])
                        cand["githubState"] = gh_state_cache.get(
                            key, {"checked": False, "why": "per-run verification cap reached"})
                cand["sourceManifestHash"] = _source_manifest_hash(cand)
                out["candidates"].append(cand)
        if not errored:
            out["accounts"][name] = f"ok:{total}_fetched:{kept}_candidates"

    out["triagePromptFingerprint"] = _prompt_fingerprint()
    # Stage 2G: the deciding model, measured from raw argv, not declared.
    # `triageModel` is passed to the intake VERBATIM, exactly like the two
    # fingerprints above. `triageModelProvenance` is evidence for the report and
    # is deliberately NOT posted: it names pids, which are noise in a receipt.
    _mi = _resolve_runtime_model_identity()
    out["triageModel"] = _mi["triageModel"]
    out["triageModelProvenance"] = _mi
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
