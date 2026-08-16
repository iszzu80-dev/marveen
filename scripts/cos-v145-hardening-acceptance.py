#!/usr/bin/env python3
"""CoS v4.4 / ZST v1.2 / ACP v1.4.5 deterministic hardening acceptance.

Source-level release gate for the cross-cutting seams that are easy to make look
"done" while one caller remains outside the invariant. It does not mutate the DB,
call a connector, send anything or infer a PASS from missing data.

Usage:
  python3 scripts/cos-v145-hardening-acceptance.py
  python3 scripts/cos-v145-hardening-acceptance.py --json

Exit codes:
  0 = PASS
  2 = BLOCKED (one or more required invariant is not structurally complete)
  3 = ERROR/UNKNOWN (the acceptance test itself could not inspect required input)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

ROOT = Path(os.environ.get("MARVEEN_REPO_ROOT") or Path(__file__).resolve().parents[1])


@dataclass
class Check:
    id: str
    status: str  # PASS | FAIL | UNKNOWN
    severity: str
    detail: str
    evidence: list[str]


def read(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        raise FileNotFoundError(rel)
    return p.read_text(encoding="utf-8")


def has_all(text: str, needles: Iterable[str]) -> bool:
    return all(n in text for n in needles)


def check_module(rel: str, needles: list[str], cid: str, detail: str, severity: str = "P1") -> Check:
    try:
        text = read(rel)
    except Exception as exc:
        return Check(cid, "UNKNOWN", severity, f"cannot inspect {rel}: {exc}", [])
    missing = [n for n in needles if n not in text]
    if missing:
        return Check(cid, "FAIL", severity, detail, [f"missing {rel}: {m}" for m in missing])
    return Check(cid, "PASS", severity, detail, [rel])


def progression_calls() -> list[str]:
    """Find runtime call sites, excluding tests and the function's own definition."""
    hits: list[str] = []
    roots = [ROOT / "src", ROOT / "scripts"]
    for base in roots:
        if not base.exists():
            continue
        for p in base.rglob("*.ts"):
            rel = p.relative_to(ROOT).as_posix()
            if "/__tests__/" in f"/{rel}/" or rel.endswith(".test.ts"):
                continue
            try:
                lines = p.read_text(encoding="utf-8").splitlines()
            except Exception:
                continue
            for i, line in enumerate(lines, 1):
                if "runProgressionCycle(" not in line:
                    continue
                # The declaration is not a caller.
                if rel == "src/cos/progression-pipeline.ts" and re.search(r"export\s+function\s+runProgressionCycle\s*\(", line):
                    continue
                hits.append(f"{rel}:{i}:{line.strip()[:160]}")
    return sorted(hits)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    checks: list[Check] = []

    checks.append(check_module(
        "src/cos/scope-gate.ts",
        ["connector identity", "explicit emberi", "target: 'personal'"],
        "NS-1", "strict connector identity owns automatic namespace",
    ))
    checks.append(check_module(
        "src/cos/temporal-facts.ts",
        ["case_temporal_facts", "VERIFIED", "UNVERIFIED", "CONFLICTED", "REJECTED"],
        "TS-1", "provenance-bound typed temporal fact store exists",
    ))
    checks.append(check_module(
        "src/cos/temporal-consistency-gate.ts",
        ["TEMPORAL_MISSING", "TEMPORAL_UNVERIFIED", "TEMPORAL_CONFLICT", "TEMPORAL_PAST_DUE", "TEMPORAL_CLAIM_MATCH_TOLERANCE_SEC"],
        "TS-2", "TSCG validates semantic kind and occurrence",
    ))
    checks.append(check_module(
        "src/cos/progression-heartbeat.ts",
        ["evaluateCaseTemporalConsistency", "temporalBlocked", "runProgressionCycle"],
        "TS-3", "scheduled live heartbeat runs TSCG before policy progression",
    ))
    checks.append(check_module(
        "src/cos/actionability.ts",
        ["ACTIONABLE", "WAITING_EXTERNAL", "WAITING_OWNER", "ORPHAN", "assertActionable"],
        "ACT-1", "shared actionability invariant exists",
    ))
    checks.append(check_module(
        "src/cos/consumer-manifest.ts",
        ["cos_feature_runs", "NO_DATA", "NO_MATCH", "NO_ACTION", "ACTED", "FAILED", "UNKNOWN"],
        "CPP-1", "consumer manifest and explicit zero semantics exist",
    ))
    checks.append(check_module(
        "scripts/cos-cycle.ts",
        ["standardFeatureResult", "successful exit but payload exposes no CPP counters", "outcome: 'UNKNOWN'"],
        "CPP-2", "every cos-cycle subprocess is normalized into CPP telemetry",
    ))
    checks.append(check_module(
        "src/cos/owner-delivery-freshness.ts",
        ["assertFreshForOwnerOrExternal", "progression_run_id", "OUTBOUND" if False else "case_evidence_packets"],
        "EV-1", "owner-question delivery uses an exact-run evidence watermark",
    ))
    checks.append(check_module(
        "scripts/cos-channel-send.ts",
        ["assertOwnerQuestionFreshForDelivery", "staleBlocked"],
        "EV-2", "final owner-facing channel delivery is freshness gated",
    ))

    # Central schema registration: lazy feature bootstrap is useful defense in
    # depth, but readiness requires a fresh database to contain the shared schema
    # after ONE call to initCosSchema().
    try:
        schema = read("src/cos/schema.ts")
        needed = [
            "ensureTemporalFactsSchema", "ensureFeatureRunSchema",
            "ensureTemporalFactsSchema(db)", "ensureFeatureRunSchema(db)",
        ]
        missing = [n for n in needed if n not in schema]
        checks.append(Check(
            "SCHEMA-1", "FAIL" if missing else "PASS", "P1",
            "root initCosSchema registers all new shared hardening schema",
            ([f"missing src/cos/schema.ts: {m}" for m in missing] if missing else ["src/cos/schema.ts"]),
        ))
    except Exception as exc:
        checks.append(Check("SCHEMA-1", "UNKNOWN", "P1", f"cannot inspect root schema: {exc}", []))

    # Structural progression-entry proof. Heartbeat is currently the scheduled
    # path and is gated. Any other direct runProgressionCycle caller must either
    # call the same case-level TSCG before it or be moved behind a shared wrapper.
    try:
        calls = progression_calls()
        unguarded: list[str] = []
        for hit in calls:
            rel = hit.split(":", 1)[0]
            text = read(rel)
            if rel == "src/cos/progression-heartbeat.ts" and "evaluateCaseTemporalConsistency" in text:
                continue
            # A future safe wrapper can make its proof explicit with this marker.
            if "TSCG_ENTRY_GUARD" in text and "evaluateCaseTemporalConsistency" in text:
                continue
            unguarded.append(hit)
        checks.append(Check(
            "TS-ENTRY", "FAIL" if unguarded else "PASS", "P1",
            "every runtime progression entry is structurally TSCG-gated",
            unguarded if unguarded else calls,
        ))
    except Exception as exc:
        checks.append(Check("TS-ENTRY", "UNKNOWN", "P1", f"cannot enumerate progression callers: {exc}", []))

    # External first-delivery freshness must live at a shared chokepoint. A
    # Personal-only or ZST-only call-site check is not enough.
    try:
        auth = read("src/cos/action-authorization.ts")
        executor = read("src/cos/executor-core.ts")
        marker = "OUTBOUND_EVIDENCE_FRESHNESS"
        covered = marker in auth and "consumeAuthorization" in auth and "consumeAuthorization" in executor
        checks.append(Check(
            "EV-EXT", "PASS" if covered else "FAIL", "P1",
            "first/retry external email delivery revalidates draft evidence at shared authorization/admission chokepoint",
            ["src/cos/action-authorization.ts", "src/cos/executor-core.ts"] if covered
            else [f"missing shared marker {marker} in action-authorization consume path"],
        ))
    except Exception as exc:
        checks.append(Check("EV-EXT", "UNKNOWN", "P1", f"cannot inspect external freshness chokepoint: {exc}", []))

    checks.append(check_module(
        "scripts/cos-clean-replay.ts",
        ["shadowOnly: true", "productionWrites: false", "autoApplyAllowed: false"],
        "CRR-1", "Clean Replay operator CLI is shadow-only / no auto-apply",
    ))
    checks.append(check_module(
        "scripts/cos-replay-export-production-snapshot.ts",
        ["query_only", "read-only"],
        "CRR-2", "production snapshot exporter declares query-only behavior",
        severity="P2",
    ))

    unknown = [c for c in checks if c.status == "UNKNOWN"]
    failed = [c for c in checks if c.status == "FAIL"]
    overall = "ERROR" if unknown else ("BLOCKED" if failed else "PASS")
    report = {
        "gate": "CoS-v4.4-ZST-v1.2-ACP-v1.4.5",
        "overall": overall,
        "counts": {
            "pass": sum(c.status == "PASS" for c in checks),
            "fail": len(failed),
            "unknown": len(unknown),
        },
        "checks": [asdict(c) for c in checks],
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"{report['gate']}: {overall}")
        for c in checks:
            print(f"[{c.status}] {c.id} {c.severity}: {c.detail}")
            for e in c.evidence[:8]:
                print(f"  - {e}")
        print(json.dumps(report["counts"], ensure_ascii=False))

    if overall == "PASS":
        return 0
    if overall == "BLOCKED":
        return 2
    return 3


if __name__ == "__main__":
    sys.exit(main())
