// APG 1.9 §12.3 -- the FRESH VERIFIER context, as a format.
//
// §12.3 defines fresh verification at the INFRASTRUCTURE level, and lists six
// things it is plus three things it is not. The six:
//
//   a) an execution identity different from the producer's;
//   b) a new session;
//   c) a targeted verifier context packet;
//   d) the immutable target;
//   e) the acceptance contract (+ verified claims, + the needed constraints);
//   f) WITHOUT the producer's full session history.
//
// The three it explicitly does NOT require -- §12.3-h -- are a different model,
// a different provider and a different agent persona. None of them appears in
// this file or in web/fresh-verifier.ts, deliberately: "fresh" here is a
// property of the CONTEXT and the IDENTITY, not a shopping list of models.
//
// This module owns (c), (d), (e) and (f) as a data shape; web/fresh-verifier.ts
// composes (a) and (b) from primitives that already exist.
//
// HOW (f) IS ENFORCED, in descending order of strength:
//   1. STRUCTURALLY: `VerifierPacketInput` has no field through which a
//      producer's session history, handoff, transcript or work log could
//      travel. A caller cannot pass what the type will not carry -- which is
//      why the input is a narrow contract-and-target shape rather than "the
//      producer's packet plus some overrides".
//   2. As a BACKSTOP scan: `findProducerHistoryMarkers()` looks for the
//      fleet's handoff shape (the /handoff skill's section headings, a pasted
//      diff, a transcript dump) in the rendered verifier packet and turns it
//      into a validation error. Same relationship the credential scan in
//      context-packet.ts has to the sensitivity rule: it is a backstop, not a
//      licence to try.
//
// Pure: no clock, no fs, no store, no model. The caller supplies `generatedAt`
// and writes the returned markdown where web/fresh-verifier.ts says.

import {
  buildContextPacket,
  renderContextPacket,
  validateContextPacket,
  type ArtifactRef,
  type ContextPacket,
  type DataSensitivity,
  type PacketValidation,
} from './context-packet.js'
import { renderCheckpoint, validateCheckpoint, type SessionCheckpoint } from './session-checkpoint.js'

/**
 * §12.3-e's acceptance contract: what the verifier is judging AGAINST, decided
 * before the verification runs and never by the verifier itself.
 */
export interface AcceptanceContract {
  /** What must hold for the work to be acceptable. One or two sentences. */
  objective: string
  /** The criteria, each independently checkable. At least one -- a contract
   *  with no criteria is a request for an opinion. */
  acceptanceCriteria: string[]
  /** §12.1's `constraints`: the hard rules that bound the judgement. */
  constraints?: string[]
  /** §12.1's `verified_claims`: what has ALREADY been established, so the
   *  verifier does not re-litigate settled ground. Claims, not narrative. */
  verifiedClaims?: string[]
  /** §12.1's `forbidden_actions`. A verifier that edits the target has
   *  destroyed the thing it was asked to judge, so this list is never empty in
   *  practice -- `buildVerifierPacket` adds that rule itself (see below). */
  forbiddenActions?: string[]
}

/**
 * §12.3-d's immutable target: WHAT is being verified, pinned so it cannot move
 * underneath the verification.
 *
 * `ref` is what makes it immutable -- a commit sha, tag or version. A target
 * named only by branch is not immutable, and this module says so rather than
 * pretending: `validateVerifierPacket` rejects an empty ref.
 */
export interface ImmutableTarget {
  /** Commit sha / tag / version the verification is pinned to. Required. */
  ref: string
  /** Base ref, so the verifier can regenerate the diff rather than be handed
   *  one. A COMMAND, never an inlined diff (session-checkpoint's rule). */
  diffBase?: string | null
  /** Paths in scope. PATHS ONLY, never contents. */
  paths?: string[]
  /** Artifacts carried by reference: path + pinned ref + sha256 + a short
   *  excerpt. The same ArtifactRef the packet validator already polices. */
  artifacts?: ArtifactRef[]
}

export interface VerifierPacketInput {
  /** The kanban card / work item under verification. */
  workItemId: string
  /** WHO produced the target. Carried so the fresh verifier can be shown to be
   *  somebody else -- §12.3-a is a comparison, and a comparison needs both
   *  sides. NOT an invitation to fetch that agent's session. */
  producerAgent: string
  /** The agent that will verify. Must differ from producerAgent; the check
   *  lives in web/fresh-verifier.ts, where the dispatch is actually minted. */
  verifierAgent: string
  contract: AcceptanceContract
  target: ImmutableTarget
  /** Explicit, like every packet's. Defaults to 'internal'. */
  dataSensitivity?: DataSensitivity
  dataSensitivityNotes?: string[]
}

/** The rule a verifier packet always carries, whatever the caller listed: a
 *  verifier that edits the target has destroyed the thing it was judging, and
 *  a verifier that reads the producer's session has stopped being fresh. */
export const VERIFIER_FORBIDDEN_ACTIONS: readonly string[] = [
  'Do NOT modify the target. You are verifying it, not fixing it -- a repaired target is no longer the target that was submitted.',
  'Do NOT read the producer\'s session, transcript, HANDOFF.md or scratch notes. Your independence from them is the only thing your verdict adds (§12.3).',
  'Do NOT accept your own verdict as acceptance. You report evidence per criterion; acceptance is a separate decision by a separate role (§9.3).',
]

/**
 * Build §12.3-c's targeted verifier context packet.
 *
 * `executionRole: 'verifier'` is the field that makes this a verifier packet
 * rather than a producer packet with different prose -- §12.1-e -- and it is
 * inside the packet hash, so a producer packet cannot be relabelled into one.
 *
 * Note what is NOT here, and could not be added without changing the input
 * type: implementation history, prior decisions, design context, the
 * producer's reasoning. §12.2 permits all four IN A PRODUCER PACKET. §12.3
 * excludes them here, and the type is the enforcement.
 */
export function buildVerifierPacket(input: VerifierPacketInput): ContextPacket {
  const c = input.contract
  const t = input.target
  const constraints = [
    `Immutable target: ${t.ref}. Verify THIS revision; if what you are looking at is not ${t.ref}, stop and say so.`,
    ...(t.diffBase ? [`Change under review: \`git diff ${t.diffBase}..${t.ref}\` -- run it, it is not pasted here.`] : []),
    ...(t.paths ?? []).map(p => `In scope: \`${p}\``),
    ...(c.constraints ?? []),
    ...(c.verifiedClaims ?? []).map(v => `Already established (do not re-litigate): ${v}`),
    ...VERIFIER_FORBIDDEN_ACTIONS,
    ...(c.forbiddenActions ?? []),
  ]
  return buildContextPacket({
    executionRole: 'verifier',
    cardId: input.workItemId,
    goal:
      `Verify, independently of the producer (${input.producerAgent}), whether the target satisfies its ` +
      `acceptance contract. ${c.objective}`,
    references: t.artifacts ?? [],
    constraints,
    dataSensitivity: input.dataSensitivity ?? 'internal',
    dataSensitivityNotes: input.dataSensitivityNotes ?? [],
    // §12.1's acceptance_criteria IS the packet's Done-when. One list, so a
    // verifier cannot be judging against criteria the contract does not name.
    doneWhen: c.acceptanceCriteria,
  })
}

// ---- (f): the producer-history backstop ------------------------------------

/**
 * Shapes that mean a producer's session came along for the ride. Named shapes
 * only -- like findSecretShapes(), this returns WHAT was found and never the
 * matched text.
 *
 * The three headings are the /handoff skill's own (see session-checkpoint.ts):
 * they are how this fleet writes a session history down, so their presence in
 * a VERIFIER packet is the §12.3-f violation in its most likely real form --
 * somebody pasting the producer's handoff into the verifier's constraints
 * "for context".
 */
const PRODUCER_HISTORY_SHAPES: Array<{ rx: RegExp; what: string }> = [
  { rx: /^##\s+Current Progress\s*$/m, what: 'a handoff "Current Progress" section' },
  { rx: /^##\s+What Worked\s*$/m, what: 'a handoff "What Worked" section' },
  { rx: /^##\s+What Didn't Work\s*$/m, what: 'a handoff "What Didn\'t Work" section' },
  { rx: /^(diff --git |@@ -\d|\+\+\+ [ab]\/|--- [ab]\/)/m, what: 'an inlined diff (the target is pinned by ref; regenerate it)' },
  { rx: /^\s*(Human|Assistant|User):\s/m, what: 'a pasted session transcript' },
]

/** Names of the producer-history shapes found in `text` (empty when none). */
export function findProducerHistoryMarkers(text: string): string[] {
  const s = String(text ?? '')
  return PRODUCER_HISTORY_SHAPES.filter(shape => shape.rx.test(s)).map(shape => shape.what)
}

export interface VerifierPacketValidation {
  ok: boolean
  /** The packet-layer validation, unchanged and not reimplemented. */
  packet: PacketValidation
  /** §12.3-specific errors, on top of the packet rules. */
  errors: Array<{ code: 'target_not_pinned' | 'no_acceptance_criteria' | 'producer_history_present' | 'role_not_verifier'; at: string; message: string }>
}

/**
 * Validate a verifier packet: everything validateContextPacket() already
 * checks, PLUS the three things §12.3 adds -- a pinned target, an acceptance
 * contract with at least one criterion, and no producer session history.
 *
 * The packet rules are DELEGATED, never re-implemented, for the same reason
 * session-checkpoint.ts delegates them: two implementations of "inlined" drift.
 */
export function validateVerifierPacket(p: ContextPacket, target: ImmutableTarget): VerifierPacketValidation {
  const packet = validateContextPacket(p)
  const errors: VerifierPacketValidation['errors'] = []
  if (p.executionRole !== 'verifier') {
    errors.push({
      code: 'role_not_verifier', at: 'executionRole',
      message: `A verifier packet must declare executionRole=verifier (§12.1-e); this one declares ${p.executionRole ?? 'nothing'}`,
    })
  }
  if (!String(target?.ref ?? '').trim()) {
    errors.push({
      code: 'target_not_pinned', at: 'target.ref',
      message: '§12.3-d: the target must be pinned to a commit/tag/version. A target that can move under the verification is not a target.',
    })
  }
  if ((p.doneWhen ?? []).length === 0) {
    errors.push({
      code: 'no_acceptance_criteria', at: 'Done when',
      message: '§12.3-e: a verifier packet must carry the acceptance contract; with no criteria the verifier is being asked for an opinion.',
    })
  }
  for (const what of findProducerHistoryMarkers(renderContextPacket(p))) {
    errors.push({
      code: 'producer_history_present', at: 'packet',
      message: `§12.3-f: the verifier packet appears to carry ${what}. The verifier's independence is the only thing its verdict adds.`,
    })
  }
  return { ok: packet.ok && errors.length === 0, packet, errors }
}

// ---- the on-disk brief a fresh session reads -------------------------------

export interface VerifierBriefInput {
  packet: ContextPacket
  target: ImmutableTarget
  contract: AcceptanceContract
  verifierAgent: string
  workItemId: string
  /** ISO string, caller-supplied (this module has no clock). */
  generatedAt: string
  dispatchId?: string | null
  /** §12.1 identity of the packet above, so the brief on disk can be tied back
   *  to the dispatch record and to the kernel's context_packet_hash. */
  packetId?: string | null
  packetHash?: string | null
}

export interface VerifierBrief {
  /** The full document written to disk. */
  markdown: string
  /** The checkpoint half, exposed so a test can assert its shape directly. */
  checkpoint: SessionCheckpoint
}

/**
 * Render the document a FRESH verifier session opens first.
 *
 * TWO HALVES, AND WHY BOTH. The first half is the rendered verifier context
 * packet -- §12.3-c itself, the thing WP4 exists to stop throwing away. The
 * second half is `renderCheckpoint()` from session-checkpoint.ts, i.e. the
 * five-section HANDOFF shape that the shipped fresh-restart machinery and the
 * agents themselves already read (context-guard-runner.ts's resumePrompt tells
 * a restarted session to open exactly this kind of file). Reusing that shape
 * is what lets a verifier brief plug into machinery that already exists
 * instead of teaching the fleet a second file convention.
 *
 * AND IT DOES ONE MORE THING, which is the reason it is worth the second half:
 * the checkpoint's `What Worked` and `What Didn't Work` sections come out
 * EMPTY -- rendered as "(nothing recorded)" -- because there is nothing to put
 * in them. That is §12.3-f made visible rather than asserted: the two sections
 * where a producer's session history would have been are present and blank, so
 * a reader can SEE the omission instead of taking somebody's word for it.
 *
 * The target lives here as a pinned commit plus a `git diff` COMMAND, never an
 * inlined diff -- session-checkpoint's own rule, unchanged.
 */
export function renderVerifierBrief(input: VerifierBriefInput): VerifierBrief {
  const { target, contract } = input
  const identity = [input.packetId, input.packetHash ? `sha256 ${input.packetHash.slice(0, 12)}` : null]
    .filter(Boolean).join(' / ')
  const checkpoint: SessionCheckpoint = {
    cardId: input.workItemId,
    dispatchId: input.dispatchId ?? null,
    agent: input.verifierAgent,
    generatedAt: input.generatedAt,
    goal: `Verify the target against the acceptance contract above. ${contract.objective}`,
    // Rendered under "## Current Progress": what is PRESENTED to the verifier,
    // which for a verification is the target's state, not anybody's progress.
    workDone: [
      `The target is pinned at ${target.ref} and is presented by reference only.`,
      'The producer\'s session history is deliberately absent (§12.3-f) -- the two narrative sections below are empty for that reason, not because nothing happened.',
      ...(identity ? [`Context packet: ${identity} (executionRole=verifier).`] : []),
    ],
    filesChanged: target.paths ?? [],
    commit: target.ref,
    diffBase: target.diffBase ?? null,
    // Empty by construction. See the function docstring: this emptiness IS the
    // §12.3-f property, and a caller cannot fill it -- there is no input for it.
    whatWorked: [],
    whatDidNotWork: [],
    decisions: (contract.verifiedClaims ?? []).map(v => `Already verified, treat as settled: ${v}`),
    openQuestions: [],
    nextStep:
      'Check each acceptance criterion below against the pinned target and report PASS / FAIL / UNKNOWN per criterion, with the evidence you used.',
    furtherSteps: contract.acceptanceCriteria.map(c => `Criterion: ${c}`),
    references: target.artifacts ?? [],
  }
  return {
    markdown: renderContextPacket(input.packet) + '\n' + renderCheckpoint(checkpoint),
    checkpoint,
  }
}

/** Validate the brief's checkpoint half with the shipped checkpoint validator
 *  (reference-only rules + credential scan), so the brief cannot inline what a
 *  handoff may not inline. */
export function validateVerifierBrief(brief: VerifierBrief) {
  return validateCheckpoint(brief.checkpoint)
}
