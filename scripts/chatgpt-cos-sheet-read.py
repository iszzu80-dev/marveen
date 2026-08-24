#!/usr/bin/env python3
"""Read a ChatGPT-CoS Google Sheet LIVE, read-only, and freeze what was read.

Istvan (2026-08-24, FINAL GO): the ChatGPT-side Chief of Staff keeps its state in
Google Sheets. This reads them for a one-off baseline import into the Marveen COS.

Two rules the whole import rests on, both enforced here rather than assumed:

  read live, never copy   No Drive copy is made. A copy would be a second source
                          of truth that starts drifting the moment it exists, and
                          the point of freezing a hash is to name exactly what was
                          read at one instant.
  freeze what you read    The bytes are hashed and the tabs are hashed. A later
                          argument about "what did the Sheet say on the 24th" is
                          then answerable, instead of a matter of memory.

The Sheets API is DISABLED on this Google project (403), so the route is the Drive
export endpoint. ODS export intermittently 500s; XLSX is the reliable target.

openpyxl is not installed and will not be: the parser below is stdlib zipfile+XML.
"""
import sys, os, io, json, zipfile, hashlib, importlib.util, urllib.request, urllib.error, urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

REPO = os.path.expanduser("~/marveen")
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RELNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKGREL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _load_google(account):
    """Reuse the MCP server's token handling rather than re-implementing OAuth.

    Deliberate: a second refresh-token implementation would be a second thing to
    get wrong with a live credential, and it would drift from the one that is
    actually exercised every day.
    """
    path = os.path.join(REPO, "mcp-servers", "google-%s-mcp.py" % account)
    spec = importlib.util.spec_from_file_location("g_" + account, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def fetch_xlsx(spreadsheet_id, account="private"):
    """Export one spreadsheet as XLSX bytes. Read-only; nothing on Drive changes."""
    g = _load_google(account)
    tok = g._get_access_token()
    url = ("https://www.googleapis.com/drive/v3/files/%s/export?mimeType=%s"
           % (spreadsheet_id, urllib.parse.quote(XLSX_MIME)))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def _col_index(ref):
    """'BC12' -> 54 (0-based column). Sheets omits empty cells, so a row must be
    rebuilt by column reference or the columns silently shift left."""
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n - 1


def read_workbook(xbytes):
    """Every named tab -> list of rows, each row a list of strings.

    Returns {tab_name: {"rows": [[str,...]], "sha256": "..."}}.
    """
    z = zipfile.ZipFile(io.BytesIO(xbytes))

    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(NS + "t")))

    rels = {}
    root = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    for rel in root.findall(PKGREL + "Relationship"):
        rels[rel.get("Id")] = rel.get("Target")

    out = {}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    for sh in wb.find(NS + "sheets").findall(NS + "sheet"):
        name = sh.get("name")
        target = rels.get(sh.get(RELNS + "id"))
        if not target:
            continue
        path = target if target.startswith("xl/") else "xl/" + target.lstrip("/")
        if path not in z.namelist():
            continue
        rows = []
        ws = ET.fromstring(z.read(path))
        data = ws.find(NS + "sheetData")
        if data is not None:
            for row in data.findall(NS + "row"):
                cells = {}
                for c in row.findall(NS + "c"):
                    ref, t = c.get("r") or "", c.get("t")
                    v = c.find(NS + "v")
                    if t == "s" and v is not None:
                        val = shared[int(v.text)] if v.text and int(v.text) < len(shared) else ""
                    elif t == "inlineStr":
                        is_ = c.find(NS + "is")
                        val = "".join(x.text or "" for x in is_.iter(NS + "t")) if is_ is not None else ""
                    else:
                        val = v.text if v is not None and v.text is not None else ""
                    if ref:
                        cells[_col_index(ref)] = val
                width = (max(cells) + 1) if cells else 0
                rows.append([cells.get(i, "") for i in range(width)])
        # Trailing padding rows: a Sheet exports formatted-but-empty rows, and
        # counting those as data is how a 999-row "table" with 11 real entries
        # gets reported as complete.
        while rows and not any(x.strip() for x in rows[-1]):
            rows.pop()
        canonical = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        out[name] = {"rows": rows,
                     "sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()}
    return out


def snapshot(spreadsheet_id, label, account="private"):
    xb = fetch_xlsx(spreadsheet_id, account)
    tabs = read_workbook(xb)
    return {
        "label": label,
        "spreadsheetId": spreadsheet_id,
        "account": account,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "exportBytes": len(xb),
        "exportSha256": hashlib.sha256(xb).hexdigest(),
        "tabs": {n: {"rows": len(t["rows"]), "sha256": t["sha256"]} for n, t in tabs.items()},
        "_data": tabs,
    }


if __name__ == "__main__":
    sid = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else sid
    account = sys.argv[3] if len(sys.argv) > 3 else "private"
    snap = snapshot(sid, label, account)
    data = snap.pop("_data")
    print(json.dumps(snap, ensure_ascii=False, indent=1))
    for name, t in data.items():
        rows = t["rows"]
        print("\n=== TAB %r  rows=%d ===" % (name, len(rows)), file=sys.stderr)
        for r in rows[:3]:
            print("   ", [c[:40] for c in r[:14]], file=sys.stderr)
