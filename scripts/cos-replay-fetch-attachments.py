#!/usr/bin/env python3
"""Clean Replay v1.0 — content-addressed attachment sidecar corpus.

READ-ONLY on Gmail. Takes the message corpus produced by
`cos-replay-export-gmail.py`, retrieves every attachment it lists, and stores
the bytes locally under their own sha256. Nothing is sent, labelled, modified
or deleted in the mailbox.

Why a sidecar and not a column in the corpus: the message corpus is a document
of RECORD (small, reviewable, quotable). Attachment blobs are bulk content.
Keeping them apart means the corpus stays readable and the blobs stay
deduplicated -- and the join between them is the sha256, not a provider id.

The Gmail attachmentId is deliberately NOT the identity: Gmail mints a fresh
one on every read, so it names nothing that outlives the call. It is used once,
in-flight, to fetch the bytes, and then discarded.

Output layout (dirs 0700, files 0600, never in git):
  <out>/blobs/<aa>/<sha256>            the bytes, written once per distinct hash
  <out>/attachment-manifest.json       canonical manifest + counters

Usage:
  python3 scripts/cos-replay-fetch-attachments.py \
    --corpus /secure/cos-replay/source-2026-08-16.json \
    --out    /secure/cos-replay/attachments
"""
from __future__ import annotations
import argparse, base64, hashlib, importlib.util, json, os, stat, sys, tempfile
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("MARVEEN_REPO_ROOT") or os.path.dirname(HERE)

# The transport-retry policy is IMPORTED, not re-implemented: the exporter's
# approved 5/15/30s errno-101-only rule must be the same rule here, and a copy
# would be free to drift out of the approval that covers it.
_spec = importlib.util.spec_from_file_location(
    "cos_replay_export_gmail", os.path.join(HERE, "cos-replay-export-gmail.py"))
EX = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(EX)

CONNECTORS = {
    "private": os.path.join(REPO, "mcp-servers", "google-private-mcp.py"),
    "zst": os.path.join(REPO, "mcp-servers", "google-zst-mcp.py"),
}


def _load_connector(account: str):
    path = CONNECTORS[account]
    if not os.path.exists(path):
        raise SystemExit(f"{account}: connector missing: {path}")
    spec = importlib.util.spec_from_file_location(f"conn_{account}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _walk(part: dict[str, Any], out: list[dict[str, Any]]) -> None:
    out.append(part)
    for sub in part.get("parts") or []:
        _walk(sub, out)


def _live_parts(mod, message_id: str) -> list[dict[str, Any]]:
    """Current attachmentIds for one message. Read-only `messages.get`."""
    def call():
        d = mod._get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}",
                     {"format": "full"})
        if d.get("error"):
            raise RuntimeError(f"message read failed: {EX._sanitize_error(str(d))}")
        return d
    d = EX._with_transport_retry("?", f"messages.get/{message_id}", call)
    parts: list[dict[str, Any]] = []
    _walk(d.get("payload") or {}, parts)
    return [p for p in parts if (p.get("filename") or "") and (p.get("body") or {}).get("attachmentId")]


def _fetch_bytes(mod, account: str, message_id: str, attachment_id: str,
                 label: str, declared: int | None) -> bytes:
    """Retrieve one attachment's bytes.

    An empty answer means two different things, and they must not be confused.
    If the provider ALSO declares `size: 0`, the attachment really is zero bytes
    (measured 2026-08-17: a 0-byte `25169.jpg` sent from a phone) -- an empty
    file is content, and its sha256 is well defined. If the provider declares
    bytes and hands back none, that is a failed read and the run stops.
    """
    def call():
        a = mod._get(f"https://gmail.googleapis.com/gmail/v1/users/me/"
                     f"messages/{message_id}/attachments/{attachment_id}")
        if a.get("error"):
            raise RuntimeError(f"attachment read failed for {label}: {EX._sanitize_error(str(a))}")
        data = a.get("data")
        if not data:
            provider_size = a.get("size")
            if provider_size == 0 and (declared in (0, None)):
                return b""
            raise RuntimeError(
                f"attachment read returned no data for {label}: provider declares "
                f"size={provider_size!r}, corpus declares sizeBytes={declared!r}")
        return base64.urlsafe_b64decode(data + "===")
    return EX._with_transport_retry(account, f"attachments.get/{message_id}", call)


def _store(out_dir: str, sha: str, raw: bytes) -> tuple[str, bool]:
    """Write once per hash. Returns (relative path, newly_written)."""
    rel = os.path.join("blobs", sha[:2], sha)
    path = os.path.join(out_dir, rel)
    if os.path.exists(path):
        if os.path.getsize(path) != len(raw):
            raise SystemExit(f"content-addressed store corrupt: {rel} has a different length")
        return rel, False
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".blob-", dir=os.path.dirname(path))
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise
    return rel, True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    corpus = json.load(open(args.corpus, encoding="utf-8"))
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    os.chmod(out_dir, 0o700)

    wanted: list[tuple[str, str, dict[str, Any]]] = []
    for m in corpus["messages"]:
        for a in m.get("attachments") or []:
            wanted.append((m["sourceAccountId"], m["messageId"], a))
    if not wanted:
        raise SystemExit("corpus lists no attachments; nothing to retrieve")

    mods = {acct: _load_connector(acct) for acct in {w[0] for w in wanted}}
    entries: list[dict[str, Any]] = []
    problems: list[str] = []
    logical_bytes = 0
    blobs: dict[str, int] = {}

    by_message: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for acct, mid, a in wanted:
        by_message.setdefault((acct, mid), []).append(a)

    for i, ((acct, mid), atts) in enumerate(sorted(by_message.items()), 1):
        mod = mods[acct]
        live = _live_parts(mod, mid)
        # Match by (filename, mimeType) against what the corpus recorded. The
        # attachmentId is in-flight only, so the pairing must stand on the
        # declared metadata that the corpus itself carries.
        pool = list(live)
        for a in atts:
            hit = None
            for p in pool:
                if (p.get("filename") or "") == a["filename"] and \
                   (p.get("mimeType") or None) == a["mimeType"]:
                    hit = p
                    break
            if hit is None:
                problems.append(f"{acct}/{mid}: no live part matches {a['filename']!r} ({a['mimeType']})")
                entries.append({**a, "sourceAccountId": acct, "messageId": mid,
                                "sha256": None, "retrievalStatus": "NO_MATCHING_PART"})
                continue
            pool.remove(hit)
            raw = _fetch_bytes(mod, acct, mid, (hit.get("body") or {})["attachmentId"],
                               f"{acct}/{mid}/{a['filename']}", a.get("sizeBytes"))
            sha = hashlib.sha256(raw).hexdigest()
            rel, fresh = _store(out_dir, sha, raw)
            blobs[sha] = len(raw)
            logical_bytes += len(raw)
            declared = a.get("sizeBytes")
            entries.append({
                "sourceAccountId": acct, "messageId": mid,
                "filename": a["filename"], "mimeType": a["mimeType"],
                "sizeBytes": declared, "retrievedBytes": len(raw),
                "sha256": sha, "blobPath": rel,
                "retrievalStatus": ("RETRIEVED_EMPTY" if not raw and declared in (0, None)
                                    else "RETRIEVED" if declared in (None, len(raw))
                                    else "RETRIEVED_SIZE_MISMATCH"),
                "blobNewlyStored": fresh,
            })
            if declared not in (None, len(raw)):
                problems.append(f"{acct}/{mid}/{a['filename']}: declared {declared} bytes, retrieved {len(raw)}")
        if i % 25 == 0:
            print(f"... {i}/{len(by_message)} messages", file=sys.stderr, flush=True)

    dup_groups: dict[str, int] = {}
    for e in entries:
        if e.get("sha256"):
            dup_groups[e["sha256"]] = dup_groups.get(e["sha256"], 0) + 1

    summary = {
        "corpus": os.path.abspath(args.corpus),
        "store": out_dir,
        "attachmentsInCorpus": len(wanted),
        "retrieved": sum(1 for e in entries if e.get("sha256")),
        "sha256Coverage": round(sum(1 for e in entries if e.get("sha256")) / len(wanted), 4),
        "failedOrUnknown": sum(1 for e in entries if not e.get("sha256")),
        "logicalBytes": logical_bytes,
        "uniqueBlobs": len(blobs),
        "physicalBytes": sum(blobs.values()),
        "duplicateHashGroups": sum(1 for c in dup_groups.values() if c > 1),
        "transportRetries": EX.RETRY_EVENTS,
        "mode": "READ_ONLY",
        "identityRule": "sha256 is the identity; the Gmail attachmentId is used in-flight and discarded",
    }
    manifest = {"summary": summary, "attachments": sorted(
        entries, key=lambda e: (e["sourceAccountId"], e["messageId"], e["filename"]))}

    mpath = os.path.join(out_dir, "attachment-manifest.json")
    fd, tmp = tempfile.mkstemp(prefix=".manifest-", dir=out_dir, text=True)
    os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, mpath)
    os.chmod(mpath, 0o600)

    print(json.dumps(summary, ensure_ascii=False))
    if problems:
        raise SystemExit("attachment retrieval is NOT complete:\n  " + "\n  ".join(problems[:20]))


if __name__ == "__main__":
    main()
