#!/usr/bin/env python3
"""ZST Control Tower — one-way projection of the ZST case store into a Google Sheet.

Slice 6 cutover: the SQLite ZST case store is the source of truth; this writes a
READ-ONLY projection of it into a Google Sheet so Istvan sees the whole ZST CoS in
a familiar spreadsheet (Ügyek / Számlák / Szerződések / Áttekintés tabs). Strictly
one-way (Case Store -> Sheet): this NEVER reads commands back from a cell and NEVER
takes an external action from sheet content (spec §17/§18 forbids unvalidated
action-from-cell and action-repeat-on-sheet-error). It only mirrors data.

Auth: reuses the google-zst OAuth token (spreadsheets + drive.file scopes, live).
Idempotent: the target spreadsheet id is stored in store/.zst-control-tower-sheet;
first run creates the sheet, later runs clear + rewrite the same one. Safe to
re-run / schedule daily.
"""
import sys, os, json, urllib.request, urllib.error, urllib.parse, sqlite3, importlib.util
from datetime import datetime, timezone, timedelta

REPO = os.path.expanduser("~/marveen")
DB = os.path.join(REPO, "store", "claudeclaw.db")
SHEET_ID_FILE = os.path.join(REPO, "store", ".zst-control-tower-sheet")
TABS = ["Áttekintés", "Ügyek", "Számlák", "Szerződések"]

spec = importlib.util.spec_from_file_location("gz", os.path.join(REPO, "mcp-servers", "google-zst-mcp.py"))
gz = importlib.util.module_from_spec(spec); spec.loader.exec_module(gz)


def _api(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + gz._get_access_token(),
        "Content-Type": "application/json",
    })
    try:
        r = urllib.request.urlopen(req)
        raw = r.read().decode()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        raise SystemExit(f"Sheets API {method} {url.split('?')[0]} -> {e.code}: {detail}")


def now_hu():
    return datetime.now(timezone(timedelta(hours=2))).strftime("%Y-%m-%d %H:%M CEST")


def ensure_spreadsheet():
    if os.path.exists(SHEET_ID_FILE):
        sid = open(SHEET_ID_FILE).read().strip()
        if sid:
            return sid, False
    created = _api("POST", "https://sheets.googleapis.com/v4/spreadsheets", {
        "properties": {"title": "ZST Radio — Control Tower"},
        "sheets": [{"properties": {"title": t}} for t in TABS],
    })
    sid = created["spreadsheetId"]
    with open(SHEET_ID_FILE, "w") as f:
        f.write(sid)
    return sid, True


def write_tab(sid, tab, rows):
    # Clear then write (RAW). rows is a list of lists (first row = header).
    _api("POST", f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/{urllib.parse.quote(tab)}:clear", {})
    _api("PUT",
         f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/{urllib.parse.quote(tab)}!A1?valueInputOption=RAW",
         {"values": rows})


def s(v):
    return "" if v is None else str(v)


def build_rows(db):
    c = db.cursor(); c.row_factory = sqlite3.Row
    cases = c.execute("""SELECT case_id,case_type,status,workspace,priority,title,sensitivity,
        datetime(created_at,'unixepoch','localtime') created FROM zst_cases ORDER BY created_at DESC""").fetchall()
    invoices = c.execute("""SELECT invoice_id,invoice_type,supplier_id,invoice_number,issue_date,due_date,
        gross_amount,currency,payment_status,case_id FROM zst_invoices ORDER BY issue_date DESC""").fetchall()
    contracts = c.execute("""SELECT contract_id,title,counterparty_id,contract_type,status,expiry_date,
        notice_period_days,termination_deadline,financial_commitment,currency FROM zst_contracts
        ORDER BY expiry_date""").fetchall()

    # Áttekintés (summary)
    by_type = {}
    for r in cases:
        by_type[r["case_type"]] = by_type.get(r["case_type"], 0) + 1
    overview = [
        ["ZST Radio — Control Tower", ""],
        ["Frissítve", now_hu()],
        ["Forrás", "Marveen ZST case store (SQLite) — egyirányú projekció, read-only"],
        ["", ""],
        ["Ügyek összesen", len(cases)],
        ["Számlák", len(invoices)],
        ["Szerződések", len(contracts)],
        ["", ""],
        ["Ügyek típus szerint", ""],
    ] + [[k, v] for k, v in sorted(by_type.items(), key=lambda x: -x[1])]

    cases_rows = [["case_id", "típus", "státusz", "workspace", "prioritás", "cím", "érzékenység", "létrehozva"]] + \
        [[s(r["case_id"]), s(r["case_type"]), s(r["status"]), s(r["workspace"]), s(r["priority"]),
          s(r["title"]), s(r["sensitivity"]), s(r["created"])] for r in cases]

    inv_rows = [["invoice_id", "típus", "szállító", "számlaszám", "kiállítás", "határidő", "bruttó", "pénznem", "fizetés", "ügy"]] + \
        [[s(r["invoice_id"]), s(r["invoice_type"]), s(r["supplier_id"]), s(r["invoice_number"]), s(r["issue_date"]),
          s(r["due_date"]), s(r["gross_amount"]), s(r["currency"]), s(r["payment_status"]), s(r["case_id"])] for r in invoices]

    ctr_rows = [["contract_id", "cím", "partner", "típus", "státusz", "lejárat", "felmondási_nap", "felmondási_határidő", "elkötelezettség", "pénznem"]] + \
        [[s(r["contract_id"]), s(r["title"]), s(r["counterparty_id"]), s(r["contract_type"]), s(r["status"]),
          s(r["expiry_date"]), s(r["notice_period_days"]), s(r["termination_deadline"]), s(r["financial_commitment"]),
          s(r["currency"])] for r in contracts]

    return {"Áttekintés": overview, "Ügyek": cases_rows, "Számlák": inv_rows, "Szerződések": ctr_rows}


def main():
    sid, created = ensure_spreadsheet()
    db = sqlite3.connect(DB)
    rows = build_rows(db)
    db.close()
    for tab in TABS:
        write_tab(sid, tab, rows[tab])
    url = f"https://docs.google.com/spreadsheets/d/{sid}/edit"
    print(json.dumps({
        "spreadsheetId": sid, "created": created, "url": url,
        "cases": len(rows["Ügyek"]) - 1, "invoices": len(rows["Számlák"]) - 1,
        "contracts": len(rows["Szerződések"]) - 1,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
