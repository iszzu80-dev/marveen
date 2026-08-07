#!/usr/bin/env python3
"""Personal CoS — copy the ChatGPT-era Drive file structure OUT to local storage.

Istvan (2026-08-07): the personal CoS is the local case store; if the ChatGPT
version saved anything to the private Google Drive, copy it out so nothing lives
only on Drive. This recursively walks the two personal-CoS roots, downloads every
file (binary via alt=media, Google-native Docs/Sheets/Slides via export), and
mirrors the folder tree under store/personal-cos-drive-archive/. Read-only on
Drive (never deletes/moves anything there). Idempotent-ish: skips a file already
downloaded with the same size.
"""
import sys, os, json, urllib.request, urllib.parse, urllib.error, importlib.util, re

REPO = os.path.expanduser("~/marveen")
OUT = os.path.join(REPO, "store", "personal-cos-drive-archive")
ROOTS = [
    ("1otA4MWhJBBBsmXRN_3f6cLLUBV-wDZen", "István – Personal Chief of Staff"),
    ("1ft6Ae9P7XoC9J5AjoL4dzEut_ao0ATQe", "Personal Chief of Staff – Ügyfájlok"),
]

spec = importlib.util.spec_from_file_location("gp", os.path.join(REPO, "mcp-servers", "google-private-mcp.py"))
gp = importlib.util.module_from_spec(spec); spec.loader.exec_module(gp)

FOLDER = "application/vnd.google-apps.folder"
# Google-native export targets (mimeType -> (export mime, extension))
EXPORT = {
    "application/vnd.google-apps.document": ("application/pdf", ".pdf"),
    "application/vnd.google-apps.spreadsheet": ("application/x-vnd.oasis.opendocument.spreadsheet", ".ods"),
    "application/vnd.google-apps.presentation": ("application/pdf", ".pdf"),
    "application/vnd.google-apps.drawing": ("image/png", ".png"),
}

stats = {"folders": 0, "files": 0, "downloaded": 0, "skipped": 0, "bytes": 0, "errors": []}


def safe(name):
    return re.sub(r'[/\x00]', "_", name).strip()[:150] or "unnamed"


def token():
    return gp._get_access_token()


def list_children(folder_id):
    out, page = [], None
    while True:
        params = {"q": f"'{folder_id}' in parents and trashed=false",
                  "fields": "nextPageToken,files(id,name,mimeType,size)", "pageSize": 200}
        if page:
            params["pageToken"] = page
        url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token()})
        try:
            r = json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as e:
            stats["errors"].append(f"list {folder_id}: {e.code}")
            return out
        out += r.get("files", [])
        page = r.get("nextPageToken")
        if not page:
            return out


def download(f, dest_dir):
    fid, name, mime = f["id"], f["name"], f["mimeType"]
    if mime in EXPORT:
        exp_mime, ext = EXPORT[mime]
        url = f"https://www.googleapis.com/drive/v3/files/{fid}/export?" + urllib.parse.urlencode({"mimeType": exp_mime})
        path = os.path.join(dest_dir, safe(name) + ext)
    else:
        url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media"
        path = os.path.join(dest_dir, safe(name))
    if os.path.exists(path) and os.path.getsize(path) > 0:
        stats["skipped"] += 1
        return
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token()})
    try:
        with urllib.request.urlopen(req) as resp:
            data = resp.read()
        with open(path, "wb") as fh:
            fh.write(data)
        stats["downloaded"] += 1
        stats["bytes"] += len(data)
    except urllib.error.HTTPError as e:
        stats["errors"].append(f"dl {name} ({mime}): {e.code} {e.read().decode()[:80]}")


def walk(folder_id, dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    for f in list_children(folder_id):
        if f["mimeType"] == FOLDER:
            stats["folders"] += 1
            walk(f["id"], os.path.join(dest_dir, safe(f["name"])))
        else:
            stats["files"] += 1
            download(f, dest_dir)


def main():
    for fid, name in ROOTS:
        stats["folders"] += 1
        walk(fid, os.path.join(OUT, safe(name)))
    print(json.dumps({**stats, "mb": round(stats["bytes"] / 1e6, 2), "out": OUT}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
