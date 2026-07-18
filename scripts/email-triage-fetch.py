#!/usr/bin/env python3
"""Fetch recent mail from both Google accounts via the local stdio MCP servers,
drop high-confidence noise deterministically, and dedup against previously
reported message ids. Prints a compact JSON candidate list for LLM judgement.

Stdlib only. Never prints credentials. Read-only.

Usage: python3 scripts/email-triage-fetch.py [--window 4d] [--mark id1,id2,...]
  --mark  record ids as reported (called AFTER a Telegram notification goes out)
"""
import json, subprocess, sys, os, re, time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(REPO, "store", "email-triage-state.json")
SERVERS = {
    "private": os.path.join(REPO, "mcp-servers", "google-private-mcp.py"),
    "zst": os.path.join(REPO, "mcp-servers", "google-zst-mcp.py"),
}

# High-confidence noise: sender substrings. Anything NOT matched stays a candidate,
# so a false negative here costs tokens, never a missed action item.
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
    blob = frm + " " + subj
    if any(k in blob for k in ALWAYS_KEEP):
        return False
    if any(s in frm for s in NOISE_SENDERS):
        return True
    if any(s in subj for s in NOISE_SUBJECTS):
        return True
    return False


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


def main():
    args = sys.argv[1:]
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
        msgs, err = call_mcp(path, f"in:inbox newer_than:{window}")
        if err:
            out["accounts"][name] = err
            hint = ("A refresh_token valoszinuleg lejart/visszavonva -> Istvan bongeszos "
                    "consentje kell (lasd google-workspace-readonly-mcp-wire skill re-auth szekcio)."
                    if err == "server_error" else "")
            out["errors"].append({"account": name, "problem": err,
                                  "meaning": "A fiok NEM lett ellenorizve -- a 0 jelolt NEM jelenti azt hogy nincs teendo.",
                                  "hint": hint})
            continue
        kept = 0
        for m in msgs:
            mid = m.get("id")
            if not mid or mid in seen:
                continue
            if is_noise(m):
                continue
            kept += 1
            out["candidates"].append({
                "account": name, "id": mid,
                "from": m.get("from"), "subject": m.get("subject"),
                "date": m.get("date"), "snippet": (m.get("snippet") or "")[:300],
            })
        out["accounts"][name] = f"ok:{len(msgs)}_fetched:{kept}_candidates"

    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
