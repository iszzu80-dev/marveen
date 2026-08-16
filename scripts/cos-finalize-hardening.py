#!/usr/bin/env python3
"""One-shot exact patcher for the CoS v4.4 / ACP v1.4.5 proof run.

This reproduces the already-proven base + first repair workspaces, then applies
only the remaining fixture and security/temporal ordering fixes. It does not
write production data or perform external effects.
"""
from pathlib import Path
from textwrap import dedent


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{path}: expected exact final repair anchor once, found {n}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


def reproduce_prior_repairs() -> None:
    wf = Path(".github/workflows/cos-structural-hardening-repair.yml").read_text(encoding="utf-8")
    marker = "          python3 - <<'PY'\n"
    close = "\n          PY\n"
    chunks = wf.split(marker)[1:]
    if len(chunks) != 2:
        raise SystemExit(f"expected exactly two repair Python heredocs, found {len(chunks)}")
    for i, chunk in enumerate(chunks, start=1):
        if close not in chunk:
            raise SystemExit(f"repair heredoc {i} has no terminator")
        code = dedent(chunk.split(close, 1)[0])
        exec(compile(code, f"cos-structural-hardening-repair.yml::<python-{i}>", "exec"), {})


def apply_remaining_repairs() -> None:
    # Security/domain ownership is a prerequisite to interpreting temporal
    # semantics. TSCG remains central for every legitimate progression entry.
    old_body = """  const body = (): ProgressionRunResult => db.transaction(() => {
    const temporal = evaluateCaseTemporalConsistency(db, domain, caseId, now)
"""
    new_body = """  const body = (): ProgressionRunResult => db.transaction(() => {
    // ACP v1.4.5 DOMAIN_BOUNDARY_BEFORE_TSCG. Security ownership is checked
    // before semantic temporal reasoning, so a wrong-domain read is recorded as
    // CROSS_DOMAIN_LEAKAGE rather than being masked by a temporal refusal.
    try {
      domainGuard(db, domain, caseId, 'runProgressionCycle')
    } catch (err) {
      if (err instanceof CrossDomainReadError) {
        return recordCrossDomainLeakageRun(
          db, randomUUID(), domain, caseId, err.message,
          canonicalTriggerType(opts.triggerType ?? 'MANUAL'),
          opts.triggerReference ?? 'domain-boundary', now,
        )
      }
      throw err
    }
    const temporal = evaluateCaseTemporalConsistency(db, domain, caseId, now)
"""
    replace_once("src/cos/progression-pipeline.ts", old_body, new_body)

    replace_once(
        "scripts/cos-v145-hardening-acceptance.py",
        '        central_gate = ("TSCG_ENTRY_GUARD" in pipeline\n'
        '                        and "evaluateCaseTemporalConsistency" in pipeline)\n',
        '        central_gate = ("TSCG_ENTRY_GUARD" in pipeline\n'
        '                        and "DOMAIN_BOUNDARY_BEFORE_TSCG" in pipeline\n'
        '                        and "evaluateCaseTemporalConsistency" in pipeline)\n',
    )

    helper = '''function ensureDraftEvidence(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number): { caseId: string; caseVersion: number } {
  const row = db.prepare(`SELECT case_id, status, case_version FROM outbound_ledger WHERE ledger_id=?`).get(ledgerId) as
    { case_id: string | null; status: string; case_version: number | null } | undefined
  if (!row?.case_id) throw new Error(`test outbound ledger has no case_id: ${ledgerId}`)
  const c = db.prepare(`SELECT version FROM personal_cases WHERE case_id=?`).get(row.case_id) as { version: number } | undefined
  if (!c) throw new Error(`test case missing: ${row.case_id}`)
  if (row.case_version == null) db.prepare(`UPDATE outbound_ledger SET case_version=? WHERE ledger_id=?`).run(c.version, ledgerId)
  if (row.status === 'PLANNED' || row.status === 'FAILED_RETRYABLE') {
    const exists = db.prepare(`SELECT 1 FROM personal_case_events WHERE case_id=? AND event_type='OUTBOUND_DRAFTED' AND source_reference=? LIMIT 1`).get(row.case_id, ledgerId)
    if (!exists) appendCaseEvent(db, {
      caseId: row.case_id, caseVersion: c.version, actor: 'test', eventType: 'OUTBOUND_DRAFTED',
      reason: 'production-equivalent draft evidence horizon for low-level outbound fixture',
      sourceSystem: 'test:executor', sourceReference: ledgerId, payload: { ledgerId },
    }, now)
  }
  return { caseId: row.case_id, caseVersion: c.version }
}

'''

    replace_once(
        "src/__tests__/cos-outbound-claim-and-quota.test.ts",
        "import { createCase, acquireClaim } from '../cos/case-store.js'\n",
        "import { createCase, acquireClaim, appendCaseEvent } from '../cos/case-store.js'\n",
    )
    replace_once(
        "src/__tests__/cos-outbound-claim-and-quota.test.ts",
        "function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {\n"
        "  const ctx = {\n"
        "    domain: 'personal' as const, caseId: null, caseVersion: null, goalVersion: null,\n",
        helper
        + "function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {\n"
        + "  const evidence = ensureDraftEvidence(db, ledgerId, now)\n"
        + "  const ctx = {\n"
        + "    domain: 'personal' as const, caseId: evidence.caseId, caseVersion: evidence.caseVersion, goalVersion: null,\n",
    )

    replace_once(
        "src/__tests__/cos-kill-switch.test.ts",
        "import { createCase } from '../cos/case-store.js'\n",
        "import { createCase, appendCaseEvent } from '../cos/case-store.js'\n",
    )
    replace_once(
        "src/__tests__/cos-kill-switch.test.ts",
        "function ticket(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {\n"
        "  const ctx = {\n"
        "    domain: 'personal' as const, caseId: null, caseVersion: null, goalVersion: null,\n",
        helper
        + "function ticket(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {\n"
        + "  const evidence = ensureDraftEvidence(db, ledgerId, now)\n"
        + "  const ctx = {\n"
        + "    domain: 'personal' as const, caseId: evidence.caseId, caseVersion: evidence.caseVersion, goalVersion: null,\n",
    )

    replace_once(
        "src/__tests__/cos-tick.test.ts",
        "import { createCase, transitionCase } from '../cos/case-store.js'\n",
        "import { createCase, transitionCase, appendCaseEvent } from '../cos/case-store.js'\n",
    )
    replace_once(
        "src/__tests__/cos-tick.test.ts",
        "function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {\n"
        "  const ctx = {\n"
        "    domain: 'personal' as const, caseId: null, caseVersion: null, goalVersion: null,\n",
        helper
        + "function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {\n"
        + "  const evidence = ensureDraftEvidence(db, ledgerId, now)\n"
        + "  const ctx = {\n"
        + "    domain: 'personal' as const, caseId: evidence.caseId, caseVersion: evidence.caseVersion, goalVersion: null,\n",
    )


if __name__ == "__main__":
    reproduce_prior_repairs()
    apply_remaining_repairs()
    print("final hardening workspace patches applied")
