// Lean Optimization Phase 2 / P2-B -- checkpoint artifact.
//
// REUSE, NOT A SECOND MACHINERY. This module renders a HANDOFF.md, in the shape
// the fleet already uses, so it plugs into the machinery that exists:
//  - src/web/context-guard-runner.ts:101 handoffPrompt() asks an agent for
//    "HANDOFF.md ... a /handoff skill struktúrája szerint" with the sections
//    Goal / Current Progress / What Worked / What Didn't Work / Next Steps;
//  - the runner detects the artifact by MTIME at handoffPathFor(name) and
//    restarts once it appears (context-guard.ts:354-359);
//  - src/web/context-guard-runner.ts:111 resumePrompt() then tells the fresh
//    session to read that same path.
// Rendering the same five sections at the same path means a checkpoint written
// by this builder is picked up, and resumed from, by the SHIPPED code with no
// new detector, no new prompt, and no new file convention.
//
// The two extra sections (`Decisions`, `Open questions`) are additive: the five
// canonical sections are all present, in order, under their exact names, so the
// existing consumer is unaffected -- it reads the file, it does not parse it.
//
// REFERENCE-BASED, like the packet: files changed are PATHS, the diff is a
// COMMAND to run against a pinned commit, and referenced artifacts go through
// the ArtifactRef/validator from context-packet.ts. A checkpoint never inlines a
// diff body, a log, or a file's contents -- the /handoff skill's own pitfall
// list says the same ("Do NOT include full file contents -- use paths and line
// numbers"; "Do NOT include secrets, tokens, or .env values").
//
// Pure: no fs, no clock, no model. The caller supplies `generatedAt` and writes
// the returned string to handoffPathFor(agent).

import {
  validateContextPacket,
  estimateFreshTokens,
  findSecretShapes,
  MAX_SECTION_CHARS,
  type ArtifactRef,
  type FreshTokenEstimate,
  type PacketValidation,
} from './context-packet.js'

export interface SessionCheckpoint {
  /** Originating kanban card id, when there is one. */
  cardId?: string | null
  /** P2-A dispatch id, when the work arrived as an instrumented dispatch. */
  dispatchId?: string | null
  /** Agent this checkpoint belongs to. */
  agent: string
  /** ISO timestamp string, supplied by the caller (this module has no clock). */
  generatedAt: string
  /** What the overall task is trying to accomplish. */
  goal: string
  /** What has been done so far -- specifics, not narrative. */
  workDone: string[]
  /** Paths touched. PATHS ONLY, never contents. */
  filesChanged: string[]
  /** Commit sha this checkpoint's work sits at, when committed. */
  commit?: string | null
  /** Base ref to diff against, so the reader can regenerate the diff instead of
   *  reading an inlined one. */
  diffBase?: string | null
  /** Approaches/tools/patterns that succeeded. */
  whatWorked?: string[]
  /** Dead ends, failures and WHY. */
  whatDidNotWork?: string[]
  /** Decisions taken (and by whom / on what basis). */
  decisions?: string[]
  /** Unresolved questions the next session inherits. */
  openQuestions?: string[]
  /** THE next executable step. Required and singular: a checkpoint whose "next
   *  step" is a wish list is not resumable. */
  nextStep: string
  /** Further concrete steps after nextStep. */
  furtherSteps?: string[]
  /** Large material carried by reference (path + ref + hash + short excerpt). */
  references?: ArtifactRef[]
}

function bullets(xs: string[] | undefined | null): string[] {
  return (xs ?? []).map(s => String(s ?? '').trim()).filter(s => s.length > 0)
}

/**
 * Render a checkpoint as a HANDOFF.md-shaped markdown document. Deterministic:
 * same input in, byte-identical output.
 */
export function renderCheckpoint(cp: SessionCheckpoint): string {
  const out: string[] = []
  const ids: string[] = []
  if (cp.cardId) ids.push(`card ${cp.cardId}`)
  if (cp.dispatchId) ids.push(`dispatch ${cp.dispatchId}`)
  out.push(`# Handoff: ${cp.goal.trim().split('\n')[0]}`)
  out.push('')
  out.push(`Generated: ${cp.generatedAt}`)
  out.push(`From: ${cp.agent}`)
  out.push(`Work item: ${ids.length ? ids.join(' | ') : '(none)'}`)
  if (cp.commit) {
    out.push(`Commit: ${cp.commit}`)
    // A COMMAND, not an inlined diff -- the reader regenerates it on demand.
    out.push(`Diff: \`git diff ${cp.diffBase ?? `${cp.commit}~1`}..${cp.commit}\``)
  }
  out.push('')

  out.push('## Goal')
  out.push(cp.goal.trim())
  out.push('')

  out.push('## Current Progress')
  const done = bullets(cp.workDone)
  if (done.length === 0) out.push('- (nothing completed yet)')
  else for (const w of done) out.push(`- ${w}`)
  const files = bullets(cp.filesChanged)
  if (files.length > 0) {
    out.push('- Files changed (paths only):')
    for (const f of files) out.push(`  - \`${f}\``)
  }
  const refs = cp.references ?? []
  if (refs.length > 0) {
    out.push('- Referenced artifacts (open these, they are not copied here):')
    for (const r of refs) {
      const hex = r.contentHash.replace(/^sha256:/i, '')
      out.push(`  - \`${r.path}\` @ ${r.ref} (sha256 ${hex.slice(0, 12)})${r.note ? ` -- ${r.note}` : ''}`)
    }
  }
  out.push('')

  out.push('## What Worked')
  const worked = bullets(cp.whatWorked)
  if (worked.length === 0) out.push('- (nothing recorded)')
  else for (const w of worked) out.push(`- ${w}`)
  out.push('')

  out.push("## What Didn't Work")
  const failed = bullets(cp.whatDidNotWork)
  if (failed.length === 0) out.push('- (nothing recorded)')
  else for (const w of failed) out.push(`- ${w}`)
  out.push('')

  out.push('## Next Steps')
  out.push(`1. ${cp.nextStep.trim()}`)
  bullets(cp.furtherSteps).forEach((s, i) => out.push(`${i + 2}. ${s}`))
  out.push('')

  out.push('## Decisions')
  const decisions = bullets(cp.decisions)
  if (decisions.length === 0) out.push('- (none recorded)')
  else for (const d of decisions) out.push(`- ${d}`)
  out.push('')

  out.push('## Open questions')
  const questions = bullets(cp.openQuestions)
  if (questions.length === 0) out.push('- (none)')
  else for (const q of questions) out.push(`- ${q}`)
  out.push('')

  return out.join('\n')
}

/** The five section headings the /handoff skill and the live runner expect. */
export const REQUIRED_HANDOFF_SECTIONS = [
  '## Goal',
  '## Current Progress',
  '## What Worked',
  "## What Didn't Work",
  '## Next Steps',
] as const

export type CheckpointIssueCode =
  | 'goal_missing'
  | 'next_step_missing'
  | 'agent_missing'
  | 'no_work_item'
  | 'inlined_diff'
  | 'inlined_material'
  | 'reference_invalid'
  | 'possible_secret'

export interface CheckpointValidation {
  ok: boolean
  errors: Array<{ code: CheckpointIssueCode; message: string; at: string }>
  estimate: FreshTokenEstimate
  /** The packet-level validation of the checkpoint's references, so the
   *  reference-not-inline rule is enforced by ONE implementation, not two. */
  referenceValidation: PacketValidation
}

/**
 * Validate a checkpoint: it must be resumable (goal + next step + an id), and it
 * must stay reference-based. The reference rules are NOT reimplemented here --
 * they are delegated to validateContextPacket() so the packet and the checkpoint
 * can never drift apart on what "inlined" means.
 */
export function validateCheckpoint(cp: SessionCheckpoint): CheckpointValidation {
  const errors: CheckpointValidation['errors'] = []
  if (!cp.goal || !cp.goal.trim()) errors.push({ code: 'goal_missing', at: 'Goal', message: 'A checkpoint must state its goal' })
  if (!cp.nextStep || !cp.nextStep.trim()) errors.push({ code: 'next_step_missing', at: 'Next Steps', message: 'A checkpoint must carry one executable next step' })
  if (!cp.agent || !cp.agent.trim()) errors.push({ code: 'agent_missing', at: 'From', message: 'A checkpoint must name the agent it came from' })
  if (!cp.cardId && !cp.dispatchId) {
    errors.push({ code: 'no_work_item', at: 'Work item', message: 'A checkpoint must reference a card id or a dispatch id to be traceable' })
  }

  // Reference-based rule, applied to the checkpoint's own free text: a unified
  // diff or a fenced file dump pasted into workDone/decisions is exactly the
  // waste this format exists to stop.
  const freeText = [
    cp.goal ?? '',
    ...(cp.workDone ?? []), ...(cp.whatWorked ?? []), ...(cp.whatDidNotWork ?? []),
    ...(cp.decisions ?? []), ...(cp.openQuestions ?? []),
    cp.nextStep ?? '', ...(cp.furtherSteps ?? []),
  ].join('\n')
  if (/^(diff --git |@@ -\d|\+\+\+ [ab]\/|--- [ab]\/)/m.test(freeText)) {
    errors.push({ code: 'inlined_diff', at: 'Current Progress', message: 'Checkpoint inlines a diff; carry the commit sha and a `git diff` command instead' })
  }
  // Same char budget the packet's free-text sections get -- a checkpoint body
  // this long is a pasted document, not a checkpoint.
  if (freeText.length > MAX_SECTION_CHARS) {
    errors.push({
      code: 'inlined_material', at: 'Current Progress',
      message: `Checkpoint body is ${freeText.length} chars (limit ${MAX_SECTION_CHARS}) -- carry large material by path+commit+hash+excerpt`,
    })
  }

  // Credential scan over the WHOLE rendered checkpoint, using the packet layer's
  // single implementation (findSecretShapes) rather than a second regex set.
  for (const what of findSecretShapes(renderCheckpoint(cp))) {
    errors.push({ code: 'possible_secret', at: 'checkpoint', message: `Checkpoint appears to contain a ${what}; carry paths and hashes only` })
  }

  // Delegate reference + excerpt rules to the packet validator.
  const referenceValidation = validateContextPacket({
    packetVersion: 'checkpoint',
    // A checkpoint is not dispatched to a role -- it is an artifact a session
    // leaves behind -- so the §12.1-e field is explicitly absent here rather
    // than borrowing the role of whoever happens to read the file next.
    executionRole: null,
    goal: cp.goal ?? '',
    references: cp.references ?? [],
    constraints: [],
    dataSensitivity: 'internal',
    dataSensitivityNotes: [],
    doneWhen: [cp.nextStep ?? ''],
  })
  for (const e of referenceValidation.errors) {
    if (e.code.startsWith('reference_') || e.code === 'excerpt_too_long' || e.code === 'artifact_inlined') {
      errors.push({ code: 'reference_invalid', at: e.at, message: e.message })
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    estimate: estimateFreshTokens(renderCheckpoint(cp)),
    referenceValidation,
  }
}
