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
import argparse, datetime as dt, json, os, stat, subprocess, sys, tempfile
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


def _tool_text(result: dict[str, Any]) -> Any:
    if result.get("isError"):
        raise RuntimeError("MCP tool reported isError=true")
    chunks = result.get("content", [])
    texts = [c.get("text", "") for c in chunks if isinstance(c, dict) and c.get("type", "text") == "text"]
    if not texts:
        return result.get("structuredContent", result)
    text = "\n".join(texts)
    try: return json.loads(text)
    except Exception: return text


def _list_tools(server: str) -> list[dict[str, Any]]:
    res = _rpc(server, "tools/list", {})
    tools = res.get("tools", [])
    if not isinstance(tools, list):
        raise RuntimeError("tools/list did not return a list")
    return tools


def _call_tool(server: str, name: str, args: dict[str, Any]) -> Any:
    if any(p in name.lower() for p in FORBIDDEN_NAME_PARTS):
        raise RuntimeError(f"refusing non-read MCP tool: {name}")
    return _tool_text(_rpc(server, "tools/call", {"name": name, "arguments": args}))


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


def _detail_args(tool: dict[str, Any], message_id: str, thread_id: str) -> dict[str, Any]:
    props = _schema_props(tool)
    for key in ("thread_id", "threadId"):
        if key in props:
            return {key: thread_id}
    for key in ("message_id", "messageId", "id"):
        if key in props:
            return {key: message_id}
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


def _body(obj: dict[str, Any]) -> str:
    for k in ("body_text", "body", "text", "plain_text", "content", "snippet"):
        v = obj.get(k)
        if isinstance(v, str) and v.strip(): return v
    payload = obj.get("payload")
    if isinstance(payload, dict):
        for k in ("body_text", "text", "decoded_text", "content"):
            v = payload.get(k)
            if isinstance(v, str) and v.strip(): return v
    raise RuntimeError("full-message read returned no readable body text; refusing snippet-only replay")


def _labels(obj: dict[str, Any]) -> list[str]:
    v = obj.get("labelIds") or obj.get("label_ids") or obj.get("labels") or []
    return [str(x).upper() for x in v] if isinstance(v, list) else []


def _normalize(account: str, obj: dict[str, Any]) -> dict[str, Any]:
    mid = str(obj.get("id") or obj.get("message_id") or "")
    tid = str(obj.get("threadId") or obj.get("thread_id") or "")
    if not mid or not tid: raise RuntimeError("full-message read missing message/thread id")
    labels = _labels(obj)
    direction = "SENT" if "SENT" in labels else "INBOUND"
    to = _header(obj, "To")
    tos = [x.strip() for x in str(to).split(",") if x.strip()] if to else []
    return {
        "sourceAccountId": account,
        "messageId": mid,
        "threadId": tid,
        "direction": direction,
        "occurredAt": _epoch(obj),
        "subject": str(_header(obj, "Subject") or obj.get("subject") or ""),
        "bodyText": _body(obj),
        "from": str(_header(obj, "From") or obj.get("from") or "") or None,
        "to": tos,
        "attachments": [],
    }


def export_account(account: str, server: str, start: dt.date, end: dt.date, maximum: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
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

    messages: dict[str, dict[str, Any]] = {}
    for mid, tid in touched.values():
        raw = _call_tool(server, str(detail["name"]), _detail_args(detail, mid, tid))
        found = _walk_messages(raw)
        if not found: raise RuntimeError(f"{account}: detail tool returned no messages for thread {tid}")
        for m in found:
            n = _normalize(account, m)
            messages[n["messageId"]] = n
        if not any(n["threadId"] == tid for n in messages.values()):
            raise RuntimeError(f"{account}: detail read did not include requested thread {tid}")

    return list(messages.values()), {
        "account": account, "anchorMessages": len(anchor), "touchedThreads": len(touched),
        "expandedMessages": len(messages), "detailTool": detail.get("name"),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True, help="exclusive YYYY-MM-DD")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-results", type=int, default=500)
    args = ap.parse_args()
    start, end = _date(args.start), _date(args.end)
    if end <= start: raise SystemExit("--end must be after --start")
    if (end - start).days < 45: raise SystemExit("Clean Replay requires at least a 45-day anchor; 60 days is the default")
    if args.max_results < 100: raise SystemExit("--max-results below 100 is too easy to truncate; refusing")

    all_messages: dict[tuple[str,str], dict[str, Any]] = {}
    reports = []
    for account, server in SERVERS.items():
        msgs, report = export_account(account, server, start, end, args.max_results)
        reports.append(report)
        for m in msgs: all_messages[(account, m["messageId"])] = m

    messages = sorted(all_messages.values(), key=lambda m: (m["occurredAt"], m["sourceAccountId"], m["messageId"]))
    corpus = {
        "generatedAt": int(dt.datetime.now(dt.timezone.utc).timestamp()),
        "anchorStart": int(dt.datetime.combine(start, dt.time.min, tzinfo=dt.timezone.utc).timestamp()),
        "anchorEnd": int(dt.datetime.combine(end, dt.time.min, tzinfo=dt.timezone.utc).timestamp()),
        "messages": messages,
        "exportEvidence": {"accounts": reports, "fullThreadExpansion": True, "readOnly": True},
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
