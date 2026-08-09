#!/usr/bin/env python3
"""COS email-attachment ingest (P2): download a Gmail message's attachments and
hand them to the unified document store via POST /api/cos/documents.

Read-only on Gmail (download only, never modifies). Works for BOTH mailboxes
(private->personal, zst->zst namespace) and for BOTH directions (inbound and the
Sent/outbound emails Istvan manually sends). Idempotent: the store dedups by
content sha per (namespace, case), so re-running never double-stores.

Usage:
  python3 scripts/cos-attachment-ingest.py <private|zst> <messageId> [caseId]
Prints a JSON summary: {stored, duplicate, skipped, files:[...]}.
"""
import sys, os, json, base64, importlib.util, urllib.request, urllib.error

REPO = os.path.expanduser("~/marveen")
TOKEN = open(os.path.join(REPO, "store", ".dashboard-token")).read().strip()
DOCS_URL = "http://localhost:3420/api/cos/documents"

if len(sys.argv) < 3:
    print("usage: cos-attachment-ingest.py <private|zst> <messageId> [caseId]"); sys.exit(2)
account = sys.argv[1]
message_id = sys.argv[2]
case_id = sys.argv[3] if len(sys.argv) > 3 else None
namespace = "zst" if account == "zst" else "personal"

mod = "google-zst-mcp.py" if account == "zst" else "google-private-mcp.py"
spec = importlib.util.spec_from_file_location("g", os.path.join(REPO, "mcp-servers", mod))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)

SKIP_MIME_PREFIX = ("text/",)  # inline text bodies, not real attachments


def walk_parts(part, out):
    """Collect (filename, mimeType, attachmentId) for parts that are real files."""
    fn = part.get("filename") or ""
    body = part.get("body") or {}
    if fn and body.get("attachmentId"):
        out.append((fn, part.get("mimeType") or "application/octet-stream", body["attachmentId"]))
    for p in part.get("parts", []) or []:
        walk_parts(p, out)


def main():
    msg = g._get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}", {"format": "full"})
    if not isinstance(msg, dict) or msg.get("error"):
        print(json.dumps({"error": "message fetch failed", "detail": str(msg)[:120]})); return
    parts = []
    walk_parts(msg.get("payload") or {}, parts)
    result = {"stored": 0, "duplicate": 0, "skipped": 0, "files": []}
    for filename, mime, att_id in parts:
        if mime.startswith(SKIP_MIME_PREFIX):
            result["skipped"] += 1; continue
        a = g._get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}/attachments/{att_id}")
        if not isinstance(a, dict) or a.get("error") or not a.get("data"):
            result["skipped"] += 1; continue
        raw = base64.urlsafe_b64decode(a["data"] + "===")  # Gmail returns base64url
        std_b64 = base64.b64encode(raw).decode()
        kind = ("invoice" if any(k in filename.lower() for k in ("szaml", "invoice", "dmrv", "gm-", "receipt"))
                else "photo" if filename.lower().endswith((".jpg", ".jpeg", ".png"))
                else "contract" if "szerzod" in filename.lower() or "contract" in filename.lower()
                else "other")
        payload = {"namespace": namespace, "source": "email", "sourceRef": message_id,
                   "filename": filename, "mimeType": mime, "contentBase64": std_b64, "docKind": kind}
        if case_id:
            payload["caseId"] = case_id
        req = urllib.request.Request(DOCS_URL, data=json.dumps(payload).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN})
        try:
            r = json.load(urllib.request.urlopen(req, timeout=30))
            if r.get("duplicate"):
                result["duplicate"] += 1
            else:
                result["stored"] += 1
            result["files"].append({"filename": filename, "bytes": len(raw), "doc": r.get("documentId"), "dup": r.get("duplicate", False)})
        except urllib.error.HTTPError as e:
            result["skipped"] += 1
            result["files"].append({"filename": filename, "error": f"{e.code}:{e.read().decode()[:80]}"})
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
