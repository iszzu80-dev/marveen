#!/usr/bin/env python3
"""Clean Replay v1.0 — immutable Gmail corpus exporter for Marveen runtime.

READ-ONLY by construction. Talks only to the existing local Google stdio MCP
servers used by email-triage-fetch.py. It discovers the server's tool schema,
requires gmail_search plus a full message/thread READ tool, and refuses to emit
a corpus when completeness cannot be demonstrated.

The output contains sensitive mail text. It is written mode 0600 and MUST stay
local; never commit it to git.

Usage:
  python3 scripts/cos-replay-export-gmail.py \
    --start 2026-06-17 --end 2026-08-17 --out /secure/replay-corpus.json

`--end` is exclusive. Threads touched in the anchor window are fetched in full,
so messages older than --start are included when they belong to a touched thread.
"""
from __future__ import annotations
import argparse, datetime as dt, json, os, re, stat, subprocess, sys, tempfile, time
from typing import Any

REPO = os.environ.get("MARVEEN_REPO_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS = {
    "private": os.path.join(REPO, "mcp-servers", "google-private-mcp.py"),
    "zst": os.path.join(REPO, "mcp-servers", "google-zst-mcp.py"),
}
FORBIDDEN_NAME_PARTS = ("send", "draft", "write", "modify", "delete", "trash", "label", "archive", "reply", "forward")
READ_NAME_PARTS = ("get", "read", "fetch")
DETAIL_PREFERRED = (
    "gmail_get_thread", "gmail_read_thread", "gmail_fetch_thread",
    "gmail_get_message", "gmail_read_message", "gmail_fetch_message",
)


# 900s, not 120s: a single anchor day is one gmail_search call, and the busiest
# day measured in the 61-day window (2026-08-16, private inbox) held 249 messages.
# The MCP's gmail_search issues one per-hit lookup to return sender and subject,
# so that day cannot finish inside 120s -- it is the one day that always fails.
# This is patience only: no retry, no pagination change, no weakened completeness
# check (a day hitting --max-results still raises).
def _rpc(server: str, method: str, params: dict[str, Any], timeout: int = 900) -> dict[str, Any]:
    init = {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cos-replay-export","version":"1"}}}
    req = {"jsonrpc":"2.0","id":2,"method":method,"params":params}
    payload = json.dumps(init) + "\n" + json.dumps(req) + "\n"
    p = subprocess.run([sys.executable, server], input=payload, text=True, capture_output=True, timeout=timeout)
    if p.returncode not in (0, None):
        raise RuntimeError(f"MCP process failed ({os.path.basename(server)}): rc={p.returncode}; stderr={p.stderr[-500:]}")
    result = None
    for line in p.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try: obj = json.loads(line)
        except Exception: continue
        if obj.get("id") == 2:
            result = obj
    if result is None:
        raise RuntimeError(f"MCP returned no response for {method}: {os.path.basename(server)}")
    if "error" in result:
        raise RuntimeError(f"MCP JSON-RPC error for {method}: {result['error']}")
    return result.get("result", {})


SECRET_PATTERNS = (
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+"), "Bearer <redacted>"),
    (re.compile(r"(?i)\"?(access_token|refresh_token|client_secret|client_id|id_token|api[_-]?key)\"?\s*[:=]\s*\"?[^\s\",}]+"),
     r"\1=<redacted>"),
    (re.compile(r"[A-Za-z0-9_\-]{40,}"), "<redacted-long-token>"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "<redacted-address>"),
)
# A status is only a status when something SAYS so. A bare three-digit number
# is not: `[Errno 101] Network is unreachable` read as "status=101" invited the
# reader to debug an HTTP 101 that never happened (measured 2026-08-17).
STATUS_RE = re.compile(r'(?i)(?:"?error"?|http|status|code)\s*[:=]?\s*([1-5]\d\d)(?![\w.])')
ERRNO_RE = re.compile(r"\[Errno (\d+)\]")
CLASS_RE = re.compile(r"(?i)\b(rate\s?limit|rateLimitExceeded|quota|timeout|timed out|unauthoriz\w+|"
                      r"invalid[_ ]grant|forbidden|not\s?found|backend\s?error|internal\s?error|"
                      r"unavailable|permission|invalid[_ ]credentials)\b")


def _sanitize_error(text: str) -> str:
    """Keep the diagnosis, drop the secrets.

    What survives: HTTP status, a recognised error class, and a short trimmed
    message. What never survives: bearer tokens, OAuth fields, any long opaque
    string, and addresses -- an error body can quote the request that caused it,
    and a replay log is not the place to learn what that request contained.
    """
    s = text or ""
    for pat, repl in SECRET_PATTERNS:
        s = pat.sub(repl, s)
    s = re.sub(r"\s+", " ", s).strip()
    status = STATUS_RE.search(s)
    errno = ERRNO_RE.search(s)
    klass = CLASS_RE.search(s)
    head = []
    if status: head.append(f"httpStatus={status.group(1)}")
    if errno: head.append(f"errno={errno.group(1)}")
    if klass: head.append(f"class={klass.group(1).lower().replace(' ', '_')}")
    head.append(f"message={s[:200] or '<empty>'}")
    return "; ".join(head)


def _tool_text(result: dict[str, Any]) -> Any:
    if result.get("isError"):
        # The provider's own diagnosis, sanitised -- not just the flag. A bare
        # "isError=true" cost a whole diagnostic run on 2026-08-17: a rate
        # limit, an expired token and a deleted thread all looked the same.
        detail = " | ".join(
            str(c.get("text", "")) for c in result.get("content", [])
            if isinstance(c, dict) and c.get("text"))
        if not detail.strip():
            raise RuntimeError("MCP tool reported isError=true; provider returned NO detail "
                               "(cannot tell rate limit from auth failure)")
        raise RuntimeError(f"MCP tool reported isError=true: {_sanitize_error(detail)}")
    chunks = result.get("content", [])
    texts = [c.get("text", "") for c in chunks if isinstance(c, dict) and c.get("type", "text") == "text"]
    if not texts:
        return result.get("structuredContent", result)
    text = "\n".join(texts)
    try: return json.loads(text)
    except Exception: return text


def _list_tools(server: str) -> list[dict[str, Any]]:
    res = _with_transport_retry(_account_of(server), "tools/list",
                                lambda: _rpc(server, "tools/list", {}))
    tools = res.get("tools", [])
    if not isinstance(tools, list):
        raise RuntimeError("tools/list did not return a list")
    return tools


# ---- transport resilience (Istvan's GO, 2026-08-17) ------------------------
# TWO measured failures, 09:41:40 and 10:19:43, both ~35 minutes into a run,
# both `[Errno 101] Network is unreachable`, and both with the network healthy
# again within twenty seconds. A 40-minute single-shot export cannot survive a
# host that blinks every half hour, so this retries THAT fault and nothing else.
#
# Deliberately absent: retry on HTTP/provider errors, auth, permission, rate
# limit, completeness or MIME faults. Those are answers, not dropped calls --
# repeating them would only turn a clear stop into a slow one.
TRANSPORT_RETRY_WAITS = (5, 15, 30)
TRANSPORT_FAULT_RE = re.compile(r"(?i)\[Errno 101\]|errno=101|Network is unreachable")
RETRY_EVENTS: list[dict[str, Any]] = []
_SLEEP = time.sleep  # injection point: tests must not really wait 50 seconds


def _is_transport_fault(err: BaseException) -> bool:
    return bool(TRANSPORT_FAULT_RE.search(str(err)))


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _with_transport_retry(account: str, operation: str, fn):
    """Run one read-only MCP call, retrying ONLY a proven transient network fault."""
    for attempt in range(1, len(TRANSPORT_RETRY_WAITS) + 2):
        try:
            return fn()
        except Exception as e:
            if not _is_transport_fault(e) or attempt > len(TRANSPORT_RETRY_WAITS):
                raise
            wait = TRANSPORT_RETRY_WAITS[attempt - 1]
            RETRY_EVENTS.append({
                "at": _now_iso(), "account": account, "operation": operation,
                "attempt": attempt, "errno": 101, "waitSeconds": wait,
                "error": str(e)[:200],
            })
            _SLEEP(wait)


def _account_of(server: str) -> str:
    for name, path in SERVERS.items():
        if path == server:
            return name
    return os.path.basename(server)


def _call_tool(server: str, name: str, args: dict[str, Any]) -> Any:
    if any(p in name.lower() for p in FORBIDDEN_NAME_PARTS):
        raise RuntimeError(f"refusing non-read MCP tool: {name}")
    return _with_transport_retry(
        _account_of(server), name,
        lambda: _tool_text(_rpc(server, "tools/call", {"name": name, "arguments": args})))


def _choose_detail_tool(tools: list[dict[str, Any]]) -> dict[str, Any]:
    by_name = {str(t.get("name")): t for t in tools}
    for name in DETAIL_PREFERRED:
        if name in by_name:
            return by_name[name]
    candidates = []
    for t in tools:
        name = str(t.get("name", "")).lower()
        if "gmail" not in name or any(x in name for x in FORBIDDEN_NAME_PARTS):
            continue
        if ("thread" in name or "message" in name) and any(x in name for x in READ_NAME_PARTS):
            candidates.append(t)
    if len(candidates) == 1:
        return candidates[0]
    names = [str(t.get("name")) for t in candidates]
    raise RuntimeError(f"cannot uniquely identify a full Gmail read tool; candidates={names}")


def _schema_props(tool: dict[str, Any]) -> dict[str, Any]:
    schema = tool.get("inputSchema") or tool.get("input_schema") or {}
    return schema.get("properties", {}) if isinstance(schema, dict) else {}


SHA256_ARGS = ("attachment_sha256", "attachmentSha256")


def _detail_args(tool: dict[str, Any], message_id: str, thread_id: str,
                 want_sha256: bool = False) -> dict[str, Any]:
    props = _schema_props(tool)
    extra: dict[str, Any] = {}
    if want_sha256:
        for key in SHA256_ARGS:
            if key in props:
                extra[key] = True
                break
    for key in ("thread_id", "threadId"):
        if key in props:
            return {key: thread_id, **extra}
    for key in ("message_id", "messageId", "id"):
        if key in props:
            return {key: message_id, **extra}
    raise RuntimeError(f"detail tool {tool.get('name')} has no recognizable id argument: {list(props)}")


def _date(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


def _search(server: str, query: str, maximum: int) -> list[dict[str, Any]]:
    raw = _call_tool(server, "gmail_search", {"query": query, "max_results": maximum})
    if isinstance(raw, dict):
        for k in ("messages", "results", "items"):
            if isinstance(raw.get(k), list): raw = raw[k]; break
    if not isinstance(raw, list):
        raise RuntimeError(f"gmail_search returned unsupported shape: {type(raw).__name__}")
    return [x for x in raw if isinstance(x, dict)]


def _anchor_search(server: str, start: dt.date, end: dt.date, maximum: int) -> list[dict[str, Any]]:
    """Daily windows avoid hidden pagination. A day hitting max is rejected."""
    seen: dict[str, dict[str, Any]] = {}
    day = start
    while day < end:
        nxt = min(day + dt.timedelta(days=1), end)
        for direction, folder in (("INBOUND", "in:inbox"), ("SENT", "in:sent")):
            q = f"{folder} after:{day:%Y/%m/%d} before:{nxt:%Y/%m/%d} -in:spam -in:trash"
            rows = _search(server, q, maximum)
            if len(rows) >= maximum:
                raise RuntimeError(
                    f"completeness cannot be proven: query hit max_results={maximum}: {q}; "
                    "increase --max-results or add provider pagination before replay")
            for row in rows:
                mid = str(row.get("id") or row.get("message_id") or "")
                if not mid:
                    raise RuntimeError(f"gmail_search row has no message id: {row.keys()}")
                copy = dict(row); copy["_anchor_direction"] = direction
                seen[mid] = copy
        day = nxt
    return list(seen.values())


def _walk_messages(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        out = []
        for x in raw: out.extend(_walk_messages(x))
        return out
    if not isinstance(raw, dict): return []
    for key in ("messages", "items"):
        if isinstance(raw.get(key), list):
            out = []
            for x in raw[key]: out.extend(_walk_messages(x))
            return out
    # A message-like object must have an id and at least one content/header signal.
    if (raw.get("id") or raw.get("message_id")) and any(k in raw for k in ("subject","snippet","body","body_text","text","payload","from","to","thread_id","threadId")):
        return [raw]
    return []


def _header(obj: dict[str, Any], key: str) -> Any:
    for k in (key, key.lower(), key.upper(), key.replace("-", "_")):
        if k in obj: return obj[k]
    headers = obj.get("headers")
    if isinstance(headers, dict):
        for k, v in headers.items():
            if str(k).lower() == key.lower(): return v
    if isinstance(headers, list):
        for h in headers:
            if isinstance(h, dict) and str(h.get("name", "")).lower() == key.lower(): return h.get("value")
    return None


def _epoch(obj: dict[str, Any]) -> int:
    for k in ("internalDate", "internal_date", "timestamp", "occurred_at", "created_at", "date"):
        v = obj.get(k)
        if v is None: continue
        try:
            n = int(v)
            if n > 10_000_000_000: n //= 1000
            if n > 0: return n
        except Exception: pass
    date = _header(obj, "Date")
    if date:
        try:
            from email.utils import parsedate_to_datetime
            d = parsedate_to_datetime(str(date))
            return int(d.timestamp())
        except Exception: pass
    raise RuntimeError("full message has no parseable timestamp")


def _body(obj: dict[str, Any]) -> tuple[str, str]:
    """Return (bodyText, bodyPresence).

    An empty body has two causes that must never be confused: the letter HAS
    no text (an attachment-only DMARC report, a photo sent with no caption),
    or we FAILED to read the text it has. Only the first may enter a replay
    corpus, and only against evidence the reader produced -- never against a
    subject line or a snippet, which are not the body.
    """
    for k in ("body_text", "body", "text", "plain_text", "content"):
        v = obj.get(k)
        if isinstance(v, str) and v.strip(): return v, "TEXT"
    payload = obj.get("payload")
    if isinstance(payload, dict):
        for k in ("body_text", "text", "decoded_text", "content"):
            v = payload.get(k)
            if isinstance(v, str) and v.strip(): return v, "TEXT"

    ev = obj.get("bodyEvidence")
    if not isinstance(ev, dict):
        raise RuntimeError(
            "full-message read returned no readable body text and no bodyEvidence; "
            "refusing snippet-only replay (the read tool cannot tell 'has no text' "
            "from 'we failed to read the text')")
    unreadable = ev.get("textPartsUnreadable")
    if ev.get("mimeTreeFullyWalked") is not True:
        raise RuntimeError(
            "empty bodyText and the reader does not claim a complete MIME walk; "
            "textlessness cannot be proven from a partial tree")
    if ev.get("textless") is True and unreadable == 0:
        return "", "TEXTLESS_PROVEN"
    raise RuntimeError(
        f"full-message read returned no body text and textlessness is NOT proven "
        f"(bodyEvidence={json.dumps(ev, ensure_ascii=False)}); refusing the corpus")


def _labels(obj: dict[str, Any]) -> list[str]:
    v = obj.get("labelIds") or obj.get("label_ids") or obj.get("labels") or []
    return [str(x).upper() for x in v] if isinstance(v, list) else []


def _attachments(obj: dict[str, Any]) -> list[dict[str, Any]]:
    """The manifest the Clean Replay hashes. `attachments: []` used to be
    hard-coded here, so a mail carrying a 2 MB photo exported as if it carried
    nothing -- an absence nobody could distinguish from a real absence.

    `attachmentId` is deliberately NOT carried over: Gmail rotates it between
    calls, so it identifies nothing in a stored corpus.
    """
    raw = obj.get("attachments")
    if raw is None:
        raise RuntimeError(
            "full-message read exposes no attachment metadata; refusing a corpus whose "
            "attachment manifest would be an unasked-for empty list")
    if not isinstance(raw, list):
        raise RuntimeError(f"attachment metadata has unsupported shape: {type(raw).__name__}")
    out = []
    for a in raw:
        if not isinstance(a, dict):
            raise RuntimeError("attachment entry is not an object")
        name = a.get("filename") or a.get("name")
        if not name:
            raise RuntimeError("attachment entry has no filename")
        out.append({
            "filename": str(name),
            "mimeType": a.get("mimeType") or a.get("mime") or None,
            "sizeBytes": a.get("sizeBytes") if a.get("sizeBytes") is not None else a.get("size"),
            "sha256": a.get("sha256"),
            "sha256Status": a.get("sha256Status") or ("COMPUTED" if a.get("sha256") else "NOT_REQUESTED"),
        })
    return out


def _normalize(account: str, obj: dict[str, Any]) -> dict[str, Any]:
    mid = str(obj.get("id") or obj.get("message_id") or "")
    tid = str(obj.get("threadId") or obj.get("thread_id") or "")
    if not mid or not tid: raise RuntimeError("full-message read missing message/thread id")
    labels = _labels(obj)
    direction = "SENT" if "SENT" in labels else "INBOUND"
    to = _header(obj, "To")
    tos = [x.strip() for x in str(to).split(",") if x.strip()] if to else []
    body, presence = _body(obj)
    return {
        "sourceAccountId": account,
        "messageId": mid,
        "threadId": tid,
        "direction": direction,
        "occurredAt": _epoch(obj),
        "subject": str(_header(obj, "Subject") or obj.get("subject") or ""),
        "bodyText": body,
        "bodyPresence": presence,
        "from": str(_header(obj, "From") or obj.get("from") or "") or None,
        "to": tos,
        "attachments": _attachments(obj),
    }


def _merge_messages(messages: dict[str, dict[str, Any]], account: str,
                    found: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Keyed by messageId, so a retried call that re-delivers a thread adds
    nothing twice. The retry above makes this property load-bearing, not
    incidental."""
    for m in found:
        n = _normalize(account, m)
        messages[n["messageId"]] = n
    return messages


def export_account(account: str, server: str, start: dt.date, end: dt.date, maximum: int,
                   want_sha256: bool = False) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not os.path.exists(server): raise RuntimeError(f"{account} MCP server missing: {server}")
    tools = _list_tools(server)
    names = {str(t.get("name")) for t in tools}
    if "gmail_search" not in names: raise RuntimeError(f"{account}: gmail_search missing")
    detail = _choose_detail_tool(tools)
    if any(x in str(detail.get("name", "")).lower() for x in FORBIDDEN_NAME_PARTS):
        raise RuntimeError(f"{account}: selected detail tool is not read-only: {detail.get('name')}")

    anchor = _anchor_search(server, start, end, maximum)
    touched: dict[str, tuple[str, str]] = {}
    for r in anchor:
        mid = str(r.get("id") or r.get("message_id") or "")
        tid = str(r.get("threadId") or r.get("thread_id") or "")
        if not tid: raise RuntimeError(f"{account}: anchor result missing thread id for {mid}")
        touched.setdefault(tid, (mid, tid))

    sha256_supported = any(k in _schema_props(detail) for k in SHA256_ARGS)
    if want_sha256 and not sha256_supported:
        raise RuntimeError(
            f"{account}: attachment sha256 was requested but {detail.get('name')} does not "
            "accept it; run with --no-attachment-sha256 to export a manifest without hashes "
            "instead of silently exporting one")

    messages: dict[str, dict[str, Any]] = {}
    for mid, tid in touched.values():
        raw = _call_tool(server, str(detail["name"]), _detail_args(detail, mid, tid, want_sha256))
        found = _walk_messages(raw)
        if not found: raise RuntimeError(f"{account}: detail tool returned no messages for thread {tid}")
        _merge_messages(messages, account, found)
        if not any(n["threadId"] == tid for n in messages.values()):
            raise RuntimeError(f"{account}: detail read did not include requested thread {tid}")

    msgs = list(messages.values())
    atts = [a for m in msgs for a in m["attachments"]]
    total_bytes = sum(a["sizeBytes"] or 0 for a in atts)
    hashed = [a for a in atts if a["sha256"]]
    return msgs, {
        "account": account, "anchorMessages": len(anchor), "touchedThreads": len(touched),
        "expandedMessages": len(messages), "detailTool": detail.get("name"),
        "textlessProven": sum(1 for m in msgs if m["bodyPresence"] == "TEXTLESS_PROVEN"),
        # The metadata manifest is complete by construction (a missing field
        # aborts). Hash coverage is a separate, explicitly reported number --
        # never implied by the manifest being present.
        "attachmentManifest": {
            "count": len(atts),
            "totalBytes": total_bytes,
            "metadataComplete": all(a["filename"] and a["mimeType"] is not None
                                    and a["sizeBytes"] is not None for a in atts),
            "sha256Requested": want_sha256,
            "sha256Count": len(hashed),
            "sha256Bytes": sum(a["sizeBytes"] or 0 for a in hashed),
            "sha256Coverage": (round(len(hashed) / len(atts), 4) if atts else 1.0),
            "sha256Unavailable": sorted({a["sha256Status"] for a in atts
                                         if not a["sha256"] and a["sha256Status"] != "NOT_REQUESTED"}),
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True, help="exclusive YYYY-MM-DD")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-results", type=int, default=500)
    ap.add_argument("--attachment-sha256", action="store_true",
                    help="ALSO hash every attachment. Off by default on purpose: hashing downloads "
                         "every attachment's bytes, so measure the manifest's count and total size "
                         "first and turn this on knowing what it will pull. Metadata (filename, "
                         "mimeType, sizeBytes) is always exported and always complete.")
    args = ap.parse_args()
    want_sha256 = args.attachment_sha256
    start, end = _date(args.start), _date(args.end)
    if end <= start: raise SystemExit("--end must be after --start")
    if (end - start).days < 45: raise SystemExit("Clean Replay requires at least a 45-day anchor; 60 days is the default")
    if args.max_results < 100: raise SystemExit("--max-results below 100 is too easy to truncate; refusing")

    all_messages: dict[tuple[str,str], dict[str, Any]] = {}
    reports = []
    for account, server in SERVERS.items():
        msgs, report = export_account(account, server, start, end, args.max_results, want_sha256)
        reports.append(report)
        for m in msgs: all_messages[(account, m["messageId"])] = m

    messages = sorted(all_messages.values(), key=lambda m: (m["occurredAt"], m["sourceAccountId"], m["messageId"]))

    # Source-completeness gate. _normalize already refuses an unproven empty
    # body one message at a time; this asserts the same rule over the finished
    # corpus, because that is the artifact the replay actually reads.
    unproven = [f'{m["sourceAccountId"]}/{m["messageId"]}' for m in messages
                if not m["bodyText"].strip() and m["bodyPresence"] != "TEXTLESS_PROVEN"]
    if unproven:
        raise SystemExit("source completeness gate: empty bodyText without TEXTLESS_PROVEN in "
                         f"{len(unproven)} message(s): {', '.join(unproven[:10])}")
    bad_manifest = [f'{m["sourceAccountId"]}/{m["messageId"]}' for m in messages
                    for a in m["attachments"]
                    if not a["filename"] or a["mimeType"] is None or a["sizeBytes"] is None]
    if bad_manifest:
        raise SystemExit("source completeness gate: incomplete attachment metadata in "
                         f"{len(bad_manifest)} message(s): {', '.join(bad_manifest[:10])}")
    corpus = {
        "generatedAt": int(dt.datetime.now(dt.timezone.utc).timestamp()),
        "anchorStart": int(dt.datetime.combine(start, dt.time.min, tzinfo=dt.timezone.utc).timestamp()),
        "anchorEnd": int(dt.datetime.combine(end, dt.time.min, tzinfo=dt.timezone.utc).timestamp()),
        "messages": messages,
        "exportEvidence": {
            "accounts": reports, "fullThreadExpansion": True, "readOnly": True,
            "bodyPresencePolicy": "empty bodyText only with bodyPresence=TEXTLESS_PROVEN; "
                                  "unproven emptiness aborts the export",
            "attachmentManifestPolicy": "declared filename/mimeType/sizeBytes from the provider, "
                                        "complete or the export aborts; sha256 only when explicitly "
                                        "requested, and its coverage is reported per account",
            "attachmentSha256Requested": want_sha256,
            "sourceCompletenessGate": "empty bodyText requires TEXTLESS_PROVEN; attachment metadata "
                                      "must be complete; both checked again over the finished corpus",
            "transportRetryPolicy": f"only [Errno 101] / Network is unreachable, at most "
                                    f"{len(TRANSPORT_RETRY_WAITS)} retries per call, waits "
                                    f"{list(TRANSPORT_RETRY_WAITS)}s; every other fault stops the export",
            "transportRetries": RETRY_EVENTS,
        },
    }

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".cos-replay-", dir=os.path.dirname(out), text=True)
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(corpus, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, out)
        os.chmod(out, 0o600)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise
    print(json.dumps({"out":out,"messages":len(messages),"accounts":reports,"mode":"READ_ONLY","fileMode":"0600"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
