import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { draftSend, approveSend } from '../cos/send-flow.js'
import { draftZstSend, approveZstSend } from '../cos/zst-send.js'
import { buildPlannedDigest } from '../cos/outbound-alert.js'
import type { ProgressionMode } from '../cos/outbound-mode-gate.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE PARITY GUARD (card 00851235)
//
// There are two outbound send paths — personal (send-flow.ts) and corporate
// (zst-send.ts) — and on 2026-08-15 three protections in a row were built on the
// personal one and skipped the corporate one:
//
//   the PLANNED daily digest, the OUTBOUND_DRAFTED timeline event, and the fifth
//   mode's approval gate.
//
// All three are closed now. A fourth item was on the original list and has been
// RETRACTED by the reporter: the autonomy ladder was already wired on the
// corporate path (zst-send.ts, `permits(...,'SEND')`), and the evidence for the
// "gap" was a past-tense comment describing the bug the code below it fixes.
//
// So the count is three, and today's live gap is ZERO. This guard is not a fix.
// It exists because wiring each of the three took an evening and the pattern
// repeated every single time — the question is not whether we can close the next
// one, it is what stops the next one from opening.
//
// ── HOW IT CHECKS, and why not by name ──
//
// A guard that greps for `mayApprove` in both files goes green the day somebody
// renames the function, and greener still if somebody types the name in a
// comment. So every probe below DRIVES THE CODE: it builds the scenario, calls
// the real entry point, and reports what actually happened.
//
// ── POSITIVE CONTROL, which is the point of the whole file ──
//
// A probe that can only return true is not a check, and a protection list where
// somebody fat-fingers an entry stays silently green — the guard would then be
// mute in precisely the mode it was built for. So each probe is also run against
// a scenario where the honest answer is FALSE, and asserted to say false. That is
// what proves the probe distinguishes rather than nods.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000
const EMAIL = { to: 'them@example.com', subject: 'Ajanlatkeres', body: 'torzs' }

type Path = 'personal' | 'zst'

function seed(path: Path, caseId: string) {
  const db = getDb()
  if (path === 'personal') {
    createCase(db, { caseId, title: 'Szemelyes ugy', caseType: 'CLAIM' }, NOW)
  } else {
    db.prepare(
      `INSERT INTO zst_cases (case_id, title, case_type, status, workspace, sensitivity,
         version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(caseId, 'Vallalati ugy', 'PROCUREMENT', 'NEW', 'OPERATIONS', 'ZST_INTERNAL', 1, NOW, NOW)
  }
}

function setMode(path: Path, caseId: string, mode: ProgressionMode) {
  getDb().prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, progression_mode,
       case_version, created_at, updated_at) VALUES (?,?,1,?,1,?,?)`
  ).run(path, caseId, mode, NOW, NOW)
}

function draft(path: Path, caseId: string, at = NOW) {
  return path === 'personal'
    ? draftSend(getDb(), { caseId, connectorId: 'gmail', templateId: 'followup-nudge', email: EMAIL, origin: 'owner' }, at)
    : draftZstSend(getDb(), { caseId, templateId: 'zst-freeform-v1', email: EMAIL }, at)
}

function approveAutomated(path: Path, d: { campaignId: string; templateHash: string; renderedPayloadHash: string }) {
  if (path === 'personal') {
    approveSend(getDb(), {
      campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash,
      approvedBy: 'robot', recipient: EMAIL.to, initiatedBy: 'automation',
    }, NOW + 1)
  } else {
    approveZstSend(getDb(), {
      campaignId: d.campaignId, templateHash: d.templateHash, renderedPayloadHash: d.renderedPayloadHash,
      approvedBy: 'robot', allowedRecipients: [EMAIL.to], initiatedBy: 'automation',
    }, NOW + 1)
  }
}

// ── The probes. Each answers "did this path show the protection?" and each is
//    capable of answering false — proven below. ────────────────────────────────

/** Does an automated approval get refused on a case whose mode forbids it? */
function probeModeGateRefusesAutomation(path: Path, mode: ProgressionMode): boolean {
  const caseId = `${path}-gate`
  seed(path, caseId)
  setMode(path, caseId, mode)
  const d = draft(path, caseId)
  try { approveAutomated(path, d); return false } catch { return true }
}

/** Does drafting leave an OUTBOUND_DRAFTED row on this path's case timeline? */
function probeTimelineEventWritten(path: Path, doDraft: boolean): boolean {
  const caseId = `${path}-evt`
  seed(path, caseId)
  if (doDraft) draft(path, caseId)
  const table = path === 'personal' ? 'personal_case_events' : 'zst_case_events'
  const n = getDb().prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE event_type='OUTBOUND_DRAFTED' AND case_id=?`
  ).get(caseId) as { n: number }
  return n.n > 0
}

/** Does the PLANNED digest see a waiting letter on this path? */
function probeDigestSeesPlanned(path: Path, doDraft: boolean): boolean {
  const caseId = `${path}-dig`
  seed(path, caseId)
  const d = doDraft ? draft(path, caseId) : null
  const digest = buildPlannedDigest(getDb(), NOW + 60)
  return d !== null && digest.text.includes(d.ledgerId)
}

const PATHS: Path[] = ['personal', 'zst']

describe('parity guard: a protection on one send path must exist on the other', () => {
  beforeEach(() => { initDatabase(':memory:') })

  describe('1. the fifth mode refuses automatic approval', () => {
    it.each(PATHS)('%s path refuses automation on external_shadow', (path) => {
      expect(probeModeGateRefusesAutomation(path, 'external_shadow')).toBe(true)
    })

    // POSITIVE CONTROL. `live` is the mode that permits it, so the honest answer
    // here is false. A probe that returned true anyway would pass the two tests
    // above while measuring nothing.
    it.each(PATHS)('%s probe says FALSE on live, where refusing would be wrong', (path) => {
      expect(probeModeGateRefusesAutomation(path, 'live')).toBe(false)
    })
  })

  describe('2. drafting is visible on the case timeline', () => {
    it.each(PATHS)('%s path writes OUTBOUND_DRAFTED', (path) => {
      expect(probeTimelineEventWritten(path, true)).toBe(true)
    })

    it.each(PATHS)('%s probe says FALSE when nothing was drafted', (path) => {
      expect(probeTimelineEventWritten(path, false)).toBe(false)
    })
  })

  describe('3. the PLANNED digest is not blind to either ledger', () => {
    it.each(PATHS)('%s path shows up in the digest', (path) => {
      expect(probeDigestSeesPlanned(path, true)).toBe(true)
    })

    it.each(PATHS)('%s probe says FALSE when nothing is waiting', (path) => {
      expect(probeDigestSeesPlanned(path, false)).toBe(false)
    })
  })

  // The guard's own completeness. If a fourth protection is added to one path and
  // this file is not extended, nothing here goes red — a guard cannot detect what
  // it was never told about, and pretending otherwise is worse than admitting it.
  //
  // So the list is stated as data and its length is pinned. Adding a protection
  // without adding a probe means editing this number, and editing a number that
  // says "read the comment above me" is a decision rather than an oversight.
  it('states how many protections it actually covers, and does not imply more', () => {
    const COVERED = [
      'mode gate refuses automatic approval',
      'OUTBOUND_DRAFTED on the case timeline',
      'PLANNED digest sees the ledger',
    ]
    expect(COVERED).toHaveLength(3)
    // Not covered here, and deliberately named rather than left silent: the
    // autonomy ladder (both paths call permits(...,'SEND'); asserted by
    // cos-dispatch-gate.test.ts and cos-zst-send.test.ts, which drive the full
    // dispatch decision this file does not build).
  })
})
