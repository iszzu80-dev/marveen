/**
 * The FOURTH Phase 1 crash boundary (owner, 2026-08-27):
 *
 *   "external action intent már durable, de az external outcome még nem
 *    bizonyított / a process a side-effect környékén meghal."
 *
 * The three boundaries already proven sit elsewhere in the lifecycle -- between
 * a decision and its run row, between an approval and its use, and inside the
 * bootstrap lock. None of them is this one. This is the boundary where the
 * machine has already told the OUTSIDE WORLD something, or may have, and then
 * stops existing before it can find out which.
 *
 * WHY A REAL PROCESS AND A REAL FILE. The provider lives in a file so its state
 * survives the death of the process that talked to it -- that is the whole
 * point: after the kill, the question "did the message go out?" has an answer,
 * and it is not in our database. A mocked adapter inside one test process cannot
 * pose that question, because the mock dies with the assertion that reads it.
 *
 * The send counter is a file for the same reason: "did the restart send again?"
 * is a claim about two processes, and only something outside both can hold it.
 *
 * Usage: outbound-crash-child.ts <dbPath> <caseId> <now> <mode> <dir> [readback]
 *   mode = plan                 create the case, the ledger row and the draft evidence
 *        = send                 first delivery, no kill (the CONTROL)
 *        = send-kill-after      the provider RECEIVES it, then SIGKILL
 *        = send-kill-before     SIGKILL before the provider receives anything
 *        = recover              recovery pass on the existing row
 *   readback = normal | unavailable   (recover only)
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../../db.js'
import { createCase, appendCaseEvent } from '../../cos/case-store.js'
import { planAction, executeAction, type OutboundAdapter, type ReadbackResult } from '../../cos/executor.js'
import { issueAuthorization } from '../../cos/action-authorization.js'
import { mintGatePermit } from '../../cos/gate-permit.js'

const [dbPath, caseId, nowRaw, mode, dir, readbackMode] = process.argv.slice(2)
if (!dbPath || !caseId || !nowRaw || !mode || !dir) {
  console.error('usage: outbound-crash-child.ts <dbPath> <caseId> <now> <mode> <dir> [readback]')
  process.exit(2)
}
const now = Number(nowRaw)
const PROVIDER = join(dir, 'provider.jsonl')
const SENDS = join(dir, 'sends.count')

const readSends = (): number => (existsSync(SENDS) ? Number(readFileSync(SENDS, 'utf8').trim() || '0') : 0)
const bumpSends = (): void => { writeFileSync(SENDS, String(readSends() + 1)) }
const providerHas = (marker: string): boolean =>
  existsSync(PROVIDER) && readFileSync(PROVIDER, 'utf8').split('\n').includes(marker)
const providerAccept = (marker: string): void => {
  writeFileSync(PROVIDER, (existsSync(PROVIDER) ? readFileSync(PROVIDER, 'utf8') + '\n' : '') + marker)
}

class FileAdapter implements OutboundAdapter {
  readonly actionType = 'EMAIL_SEND'
  async send(a: { externalIdempotencyMarker: string; sequenceNumber: number }): Promise<{ externalRef: string }> {
    // COUNTED FIRST, always. A send that dies before it can be counted is a send
    // the test cannot see, and "no second send" would then be true for the wrong
    // reason.
    bumpSends()
    if (mode === 'send-kill-before') {
      // The process dies with the intent durable (SENDING is already written)
      // and the provider untouched.
      process.kill(process.pid, 'SIGKILL')
    }
    providerAccept(a.externalIdempotencyMarker)
    if (mode === 'send-kill-after') {
      // The side effect HAS happened and nothing in our store knows it.
      process.kill(process.pid, 'SIGKILL')
    }
    return { externalRef: `ext-${a.sequenceNumber}` }
  }
  async readback(marker: string): Promise<ReadbackResult> {
    if (readbackMode === 'unavailable') return { found: false, available: false }
    return providerHas(marker) ? { found: true, externalRef: 'ext-rb' } : { found: false }
  }
}

initDatabase(dbPath)
const db = getDb()
/** READ the ledger id, never construct it. `planAction` owns the id format, and
 *  a test that hard-codes it is testing its own guess -- the first version of
 *  this file did exactly that and could not find the row it had just written. */
function ledgerIdFor(): string {
  const r = db.prepare(
    `SELECT ledger_id FROM outbound_ledger WHERE case_id = ? ORDER BY rowid LIMIT 1`,
  ).get(caseId) as { ledger_id: string } | undefined
  if (!r) throw new Error(`no outbound_ledger row for ${caseId}`)
  return r.ledger_id
}

if (mode === 'plan') {
  createCase(db, {
    caseId, title: caseId, caseType: 'ADMIN', status: 'READY',
    sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'test',
  }, now - 100)
  const a = planAction(db, {
    caseId, actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'x@y.z' },
  }, now)
  const v = db.prepare(`SELECT version FROM personal_cases WHERE case_id=?`).get(caseId) as { version: number }
  db.prepare(`UPDATE outbound_ledger SET case_version=? WHERE ledger_id=?`).run(v.version, a.ledgerId)
  appendCaseEvent(db, {
    caseId, caseVersion: v.version, actor: 'test', eventType: 'OUTBOUND_DRAFTED',
    reason: 'crash-boundary fixture: production-equivalent draft evidence horizon',
    sourceSystem: 'test:crash', sourceReference: a.ledgerId, payload: { ledgerId: a.ledgerId },
  }, now)
  console.log(JSON.stringify({ ok: true, ledgerId: a.ledgerId, marker: a.externalIdempotencyMarker }))
  process.exit(0)
}

const LEDGER = ledgerIdFor()
const ctx = {
  domain: 'personal' as const, caseId, caseVersion: null, goalVersion: null,
  actionId: LEDGER, actionType: 'EMAIL_SEND', intent: 'SEND_APPROVED_EMAIL',
  targetReference: null, recipient: 'x@y.z', payloadHash: null, approvalId: null,
}

void (async () => {
  const adapter = new FileAdapter()
  try {
    const r = mode === 'recover'
      // The SAME entry point production uses. `executeAction` on a SENDING or
      // OUTCOME_UNKNOWN row routes to recovery -- reaching for `recoverAction`
      // directly would test a path the restart does not take.
      ? await executeAction(db, adapter, LEDGER, now)
      : await executeAction(db, adapter, LEDGER, now, {
          authorizationId: issueAuthorization(
            db, ctx, now, {}, mintGatePermit({ allowed: true, reasons: [] }),
          ).authorizationId,
          authorizationContext: ctx,
        })
    console.log(JSON.stringify({
      ok: true, status: r.status, sends: readSends(),
      marker: r.externalIdempotencyMarker, externalRef: r.externalRef,
    }))
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err), sends: readSends() }))
    process.exitCode = 1
  }
})()
