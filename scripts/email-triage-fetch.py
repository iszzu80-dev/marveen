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
    "notifications@github.com", "posthog.com", "hellonancy.com",
    "ft.com", "otpbank", "globalmarkets", "ikea", "ecipo", "biggeorge",
    "lindy.ai", "telekom", "mailchimp", "sendgrid", "substack",
    # bulk/marketing sender shapes (HU newsletters use these heavily)
    "news@", "napi@", "hirlevel", "promo@", "offers@", "shop@", "store@",
    "@my.", "@news.", "@lc.", "ajanlo.", "temu", "info@info.",
    "noreply-", "dmarc", "@bk.", "bizalomkartya",
]
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


def is_noise(m):
    frm = _norm(m.get("from"))
    subj = _norm(m.get("subject"))
    snip = _norm(m.get("snippet"))
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
]


def selftest():
    bad = [(want, m) for want, m in SELFTEST if is_noise(m) != want]
    for want, m in bad:
        print("FAIL want_noise=%s got=%s :: %s | %s" % (want, not want, m["from"], m["subject"]))
    print(json.dumps({"selftest": "FAIL" if bad else "PASS",
                      "cases": len(SELFTEST), "failed": len(bad)}))
    sys.exit(1 if bad else 0)


def load_state():
    try:
        with open(STATE) as f:
            d = json.load(f)
            return set(d.get("reported_ids", [])), d
    except Exception:
        return set(), {}


def save_state(ids, prev):
    # keep the most recent 500 ids so the file cannot grow without bound
    keep = list(ids)[-500:]
    prev = prev or {}
    prev["reported_ids"] = keep
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
                cand["sourceManifestHash"] = _source_manifest_hash(cand)
                out["candidates"].append(cand)
        if not errored:
            out["accounts"][name] = f"ok:{total}_fetched:{kept}_candidates"

    out["triagePromptFingerprint"] = _prompt_fingerprint()
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
