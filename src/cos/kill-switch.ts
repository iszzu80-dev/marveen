// Personal Chief of Staff (COS) — the global kill switch (§22, card 89b2ab52).
//
// The mechanism already existed and had no way to be operated. `pauseAll` sets
// a flag that every `permits()` decision reads, and nothing — no endpoint, no
// script, no scheduled task — ever called it. `cos_autonomy_global` had zero
// rows, so the flag had never once been set. In the words of the card: if
// Istvan says "stop everything, now", there is no button.
//
// A kill switch has requirements a normal feature does not:
//
//  - It must work when the thing it stops is misbehaving. Hence a CLI entry
//    point (scripts/cos-kill-switch.ts) as well as an HTTP one: a switch that
//    only exists inside the dashboard is useless in the hour the dashboard is
//    the problem.
//  - Engaging must invalidate authority ALREADY GRANTED, not merely refuse new
//    grants. §22.2 says an authorization whose authority is withdrawn before
//    execution must block. So engaging revokes every outstanding action ticket.
//  - It must be auditable afterwards: who, when, why, and how many tickets it
//    killed.
//
// What it deliberately does NOT stop: recovery of an action that already left
// PLANNED. Those readbacks send nothing — they resolve rows whose outcome is
// unknown. Freezing them would leave a stopped system full of rows nobody can
// ever settle, which is a worse state to be stuck in than the one being stopped.
import type Database from 'better-sqlite3'

export interface KillSwitchState {
  engaged: boolean
  reason: string | null
  updatedAt: number | null
}

export interface EngageResult {
  engaged: true
  ticketsRevoked: number
}

/** Read the switch. Fail-safe direction: a missing row means NOT engaged, which
 *  matches the historical default — but see `assertNotEngaged`, which is what
 *  callers should use, because reading a boolean and acting on it later is the
 *  check-then-act shape this codebase keeps getting bitten by. */
export function killSwitchState(db: Database.Database): KillSwitchState {
  const r = db.prepare(`SELECT paused, reason, updated_at FROM cos_autonomy_global WHERE id = 1`)
    .get() as { paused: number; reason: string | null; updated_at: number } | undefined
  return { engaged: r?.paused === 1, reason: r?.reason ?? null, updatedAt: r?.updated_at ?? null }
}

/**
 * STOP. Sets the global pause, revokes every outstanding authorization ticket,
 * and records who did it and why.
 *
 * One transaction: a stop that pauses but leaves live tickets behind is a stop
 * that lets the next few seconds of sends through, and those are exactly the
 * seconds someone is trying to prevent.
 */
export function engageKillSwitch(
  db: Database.Database, args: { reason: string; actor: string }, now: number,
): EngageResult {
  return db.transaction((): EngageResult => {
    db.prepare(
      `INSERT INTO cos_autonomy_global (id, paused, reason, updated_at) VALUES (1, 1, @r, @now)
       ON CONFLICT(id) DO UPDATE SET paused=1, reason=@r, updated_at=@now`
    ).run({ r: `${args.reason} (${args.actor})`, now })

    // §22.2: authority granted before the stop must not survive it.
    let ticketsRevoked = 0
    try {
      ticketsRevoked = db.prepare(
        `UPDATE action_authorizations SET consumed_at = @now WHERE consumed_at IS NULL`
      ).run({ now }).changes
    } catch {
      // An older store may predate the table. A missing ticket table cannot make
      // the stop fail — the pause is the part that must always land.
    }

    db.prepare(
      `INSERT INTO cos_kill_switch_events (engaged, reason, actor, tickets_revoked, created_at)
       VALUES (1, @reason, @actor, @n, @now)`
    ).run({ reason: args.reason, actor: args.actor, n: ticketsRevoked, now })

    return { engaged: true, ticketsRevoked }
  })()
}

/** Release. Deliberately NOT the inverse of engage: it does not resurrect the
 *  revoked tickets. Anything that was in flight when the stop landed goes back
 *  through the gate, which is the point — the stop happened for a reason and
 *  that reason may still be true for a particular action. */
export function releaseKillSwitch(
  db: Database.Database, args: { actor: string; reason?: string }, now: number,
): KillSwitchState {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO cos_autonomy_global (id, paused, reason, updated_at) VALUES (1, 0, @r, @now)
       ON CONFLICT(id) DO UPDATE SET paused=0, reason=@r, updated_at=@now`
    ).run({ r: args.reason ?? `released by ${args.actor}`, now })
    db.prepare(
      `INSERT INTO cos_kill_switch_events (engaged, reason, actor, tickets_revoked, created_at)
       VALUES (0, @reason, @actor, 0, @now)`
    ).run({ reason: args.reason ?? 'released', actor: args.actor, now })
  })()
  return killSwitchState(db)
}

/** The form callers should use at a choke point: throwing/refusing on the spot
 *  rather than handing back a boolean somebody remembers to check. */
export function killSwitchRefusal(db: Database.Database): string | null {
  const s = killSwitchState(db)
  if (!s.engaged) return null
  return `global kill switch engaged${s.reason ? `: ${s.reason}` : ''}`
}
