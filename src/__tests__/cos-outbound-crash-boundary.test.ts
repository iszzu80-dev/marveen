// The FOURTH Phase 1 crash boundary (owner, 2026-08-27 final gate).
//
//   "external action intent már durable, de az external outcome még nem
//    bizonyított / a process a side-effect környékén meghal."
//
// The three boundaries already proven are elsewhere in the lifecycle: between a
// decision and its run row (P6 scenario 10), between an approval and its use
// (P4 blocker closure), and inside the bootstrap lock (Phase 0 operational
// safety). The owner's ruling is that the third of those does not stand in for
// this one, and he is right -- the bootstrap lock protects a boot, not a send.
//
// This boundary is the only one where the OUTSIDE WORLD may already have acted.
// Everything else a crash can lose is ours to rebuild; a message that left the
// machine is not. So the process is killed at two different points around the
// side effect, and the question the restart must answer is the one the store
// cannot: did it go out?
//
// WHY REAL PROCESSES AND A FILE FOR THE PROVIDER. The provider's state has to
// SURVIVE the death of the process that talked to it -- that is what makes the
// question askable afterwards. A mocked adapter inside one test process dies
// with the assertion that would read it. The send counter is a file for the same
// reason: "did the restart send again?" is a claim about two processes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SENDING_RECOVERY_GRACE_SEC } from '../cos/executor-core.js'

const CHILD = join(process.cwd(), 'src/__tests__/support/outbound-crash-child.ts')
const NOW = 1_700_000_000

interface ChildOut { ok: boolean; status?: string; sends?: number; marker?: string; externalRef?: string; error?: string; ledgerId?: string }

describe('crash boundary 4: the process dies around the side effect', () => {
  let dir: string
  let dbPath: string

  const run = (caseId: string, at: number, mode: string, readback?: string) =>
    spawnSync(process.execPath, [
      '--import', 'tsx', CHILD, dbPath, caseId, String(at), mode, dir, ...(readback ? [readback] : []),
    ], { encoding: 'utf8', timeout: 120_000 })

  const parse = (r: { stdout: string }): ChildOut => {
    const line = r.stdout.split('\n').map(l => { try { return JSON.parse(l) as ChildOut } catch { return null } })
      .filter((v): v is ChildOut => v !== null && typeof v.ok === 'boolean').pop()
    if (!line) throw new Error(`no verdict from the child: ${r.stdout.slice(-400)}`)
    return line
  }

  const sends = (): number => (existsSync(join(dir, 'sends.count')) ? Number(readFileSync(join(dir, 'sends.count'), 'utf8')) : 0)
  const providerLines = (): string[] => (existsSync(join(dir, 'provider.jsonl'))
    ? readFileSync(join(dir, 'provider.jsonl'), 'utf8').split('\n').filter(Boolean) : [])

  /** Read the row by CASE, not by a constructed ledger id: the id format belongs
   *  to `planAction`, and a test that hard-codes it asserts against its own
   *  guess. The first version of this file did, and looked for a row that was
   *  never named that. */
  function ledger(caseId: string): Record<string, unknown> {
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare(`SELECT * FROM outbound_ledger WHERE case_id = ? ORDER BY rowid LIMIT 1`)
      .get(caseId) as Record<string, unknown>
    db.close()
    return row
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbound-crash-'))
    dbPath = join(dir, 'claudeclaw.db')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the CONTROL: the same path, no kill, sends exactly once and verifies', () => {
    // Without this, every "it did not send again" below is indistinguishable
    // from "the child never sent at all".
    const plan = parse(run('c-ok', NOW, 'plan'))
    expect(plan.ok).toBe(true)
    const sent = parse(run('c-ok', NOW, 'send'))
    expect(sent.ok, sent.error).toBe(true)
    expect(sends()).toBe(1)
    expect(providerLines()).toHaveLength(1)
    expect(sent.status).toBe('VERIFIED')
  }, 120_000)

  it('HEADLINE: killed AFTER the provider took it — no blind resend, and readback verifies', () => {
    parse(run('c-after', NOW, 'plan'))
    const killed = run('c-after', NOW, 'send-kill-after')
    // ASSERT THE KILL. A clean exit would mean the seam never fired and every
    // assertion below would be about a process that simply finished.
    expect(killed.signal).toBe('SIGKILL')

    // THE SIDE EFFECT HAPPENED, and our store does not know it.
    expect(providerLines()).toHaveLength(1)
    expect(sends()).toBe(1)

    // THE INTENT IS DURABLE. The row survived the crash in SENDING, with its
    // idempotency marker intact -- that marker is the only thing that can later
    // ask the provider whether this exact message arrived.
    const before = ledger('c-after')
    expect(before.status).toBe('SENDING')
    expect(before.external_idempotency_marker).toBeTruthy()
    expect(before.internal_idempotency_key).toBeTruthy()

    // THE RESTART. Same entry point production takes; the grace window is
    // respected, so recovery happens on the second pass, not immediately.
    const early = parse(run('c-after', NOW + 60, 'recover'))
    expect(early.status).toBe('SENDING')
    expect(sends()).toBe(1)

    const recovered = parse(run('c-after', NOW + SENDING_RECOVERY_GRACE_SEC + 60, 'recover'))
    // Readback found the marker at the provider: the send DID land.
    expect(recovered.status).toBe('VERIFIED')
    // ...and it was verified by ASKING, not by sending again.
    expect(sends()).toBe(1)
    expect(providerLines()).toHaveLength(1)
    expect(ledger('c-after').verified_at).toBeTruthy()
  }, 180_000)

  it('readback UNAVAILABLE after the crash stays an explicit unresolved state, and never resends', () => {
    parse(run('c-blind', NOW, 'plan'))
    expect(run('c-blind', NOW, 'send-kill-after').signal).toBe('SIGKILL')
    expect(sends()).toBe(1)

    const r = parse(run('c-blind', NOW + SENDING_RECOVERY_GRACE_SEC + 60, 'recover', 'unavailable'))
    // Not VERIFIED, not re-queued: named as unknown, which is the only honest
    // answer when the provider cannot be asked.
    expect(r.status).toBe('OUTCOME_UNKNOWN')
    expect(sends()).toBe(1)
    expect(String(ledger('c-blind').last_error)).toMatch(/readback unavailable/)

    // AND IT STAYS THERE. A second recovery pass with the provider still
    // unreachable must not get bored and try again.
    const again = parse(run('c-blind', NOW + SENDING_RECOVERY_GRACE_SEC + 600, 'recover', 'unavailable'))
    expect(again.status).toBe('OUTCOME_UNKNOWN')
    expect(sends()).toBe(1)
  }, 180_000)

  it('killed BEFORE the provider saw it: only a PROVEN absence allows the resend', () => {
    // The mirror image, and the one that keeps the rule from being "never send
    // again", which would strand every crashed send for ever.
    parse(run('c-before', NOW, 'plan'))
    expect(run('c-before', NOW, 'send-kill-before').signal).toBe('SIGKILL')
    expect(sends()).toBe(1)
    expect(providerLines()).toHaveLength(0)   // the world never heard anything

    // With the provider UNREACHABLE, absence is not proven -- so still no resend.
    const blind = parse(run('c-before', NOW + SENDING_RECOVERY_GRACE_SEC + 60, 'recover', 'unavailable'))
    expect(blind.status).toBe('OUTCOME_UNKNOWN')
    expect(sends()).toBe(1)

    // With a WORKING readback the absence IS proven, and only now may the row go
    // back for delivery.
    const proven = parse(run('c-before', NOW + SENDING_RECOVERY_GRACE_SEC + 120, 'recover'))
    expect(proven.status).toBe('PLANNED')
    expect(sends()).toBe(1)

    const resent = parse(run('c-before', NOW + SENDING_RECOVERY_GRACE_SEC + 180, 'send'))
    expect(resent.status).toBe('VERIFIED')
    expect(sends()).toBe(2)
    // ONE message at the provider, not two: the resend is the FIRST delivery,
    // and the marker is the same one the crashed attempt carried.
    expect(providerLines()).toHaveLength(1)
  }, 180_000)
})
