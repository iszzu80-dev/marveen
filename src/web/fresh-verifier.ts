// APG 1.9 §12.3 (WP4) -- fresh verification, composed from primitives that
// already shipped.
//
// §12.3 is an INFRASTRUCTURE definition, not a prompt-engineering one. It asks
// for six things, and every one of them already had a mechanism in this
// repository; what was missing was the composition. Where each comes from:
//
//   a) different execution identity -> costops/dispatch.createDispatch with
//      role 'verifier' (WP3's §11.2 column, previously declared and unwritten)
//      for an agent that is provably not the producer. The refusal when they
//      are the same agent is §26's first invariant at the only place it can be
//      enforced: before the dispatch exists.
//   b) new session                  -> context-guard-runner.restartSessionFresh
//      (i.e. restartAgentProcess(name, { fresh: true }) / the main-safe hard
//      restart), until now driven only by context saturation.
//   c) targeted verifier packet     -> verifier-packet.buildVerifierPacket
//   d) immutable target             -> ImmutableTarget, pinned by ref
//   e) acceptance contract          -> AcceptanceContract, the packet's
//      Done-when
//   f) no producer session history  -> the input type carries none, plus the
//      backstop scan in verifier-packet.ts
//
// §12.3-h is explicit that a different model, provider or agent persona is NOT
// required. Nothing here selects a model, and nothing here should ever start
// to: "fresh" is a property of the identity and the context.
//
// THE COST GATE IS §12.4 AND IT IS UNRESOLVED. This function asks
// verifier-policy before it does anything, and under an unknown risk class it
// REFUSES rather than defaulting to "one verifier, to be safe". See
// verifier-policy.ts for why that refusal is the honest answer and what §18
// would have to supply to turn it into a decision. A caller that wants a
// verifier anyway must pass an explicit `policyOverride` reason, which is
// returned in the result and recorded by whoever records the result.
//
// EVERY EFFECT IS INJECTABLE. `FreshVerifierDeps` exists so the composition can
// be tested without tmux, without a real agent and without touching the
// filesystem -- this container runs as root, so a test may never rely on a
// permission bit to make a write fail.

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import { createDispatchSafe } from '../costops/dispatch.js'
import { resolveDispatchIdentitySafe } from '../costops/dispatch-identity.js'
import { recordPacketMetadataSafe } from '../costops/packet-metadata.js'
import { derivePacketMetadata, packetIdentity } from '../context-packet.js'
import {
  buildVerifierPacket,
  renderVerifierBrief,
  validateVerifierBrief,
  validateVerifierPacket,
  type AcceptanceContract,
  type ImmutableTarget,
} from '../verifier-packet.js'
import { mayDispatchFreshVerifier, type VerifierPolicyDecision } from '../verifier-policy.js'
import type { ApgRisk } from '../apg/ui-types.js'
import { restartSessionFresh, agentSessionFor, agentWorkingDir } from './context-guard-runner.js'
import { sendPromptToSession } from './agent-process.js'

/** Filename of the verifier's brief inside the agent's working directory.
 *  Deliberately NOT HANDOFF.md: the saturation guard detects a handoff by that
 *  path's mtime, and a verifier brief landing there would read as a producer
 *  handoff to a mechanism that has nothing to do with verification. */
export const VERIFIER_BRIEF_FILENAME = 'VERIFIER-BRIEF.md'

export interface FreshVerifierInput {
  workItemId: string
  producerAgent: string
  verifierAgent: string
  contract: AcceptanceContract
  target: ImmutableTarget
  project?: string | null
  /** §12.4's input. Today this is 'unknown' for every real change (§18 is
   *  unbuilt) -- pass what you actually know, never a placation. */
  risk?: ApgRisk | null
  /** §18.2's question, only consulted at MEDIUM. */
  acceptanceIsSemantic?: boolean
  /** An explicit, recorded reason for dispatching under UNRESOLVED risk. */
  policyOverride?: string | null
}

export type FreshVerifierReason =
  | 'FRESH_VERIFICATION_DISPATCHED'
  | 'VERIFIER_POLICY_REFUSED'
  | 'VERIFIER_IS_PRODUCER'
  | 'VERIFIER_PACKET_INVALID'
  | 'VERIFIER_BRIEF_INVALID'
  | 'FRESH_SESSION_FAILED'

export interface FreshVerifierResult {
  dispatched: boolean
  reasonCode: FreshVerifierReason
  detail: string
  policy: VerifierPolicyDecision
  /** Present as soon as the packet is built, dispatched or not -- a refused
   *  verification still identifies the context it refused to send. */
  packetId: string | null
  packetHash: string | null
  dispatchId: string | null
  briefPath: string | null
  /** The rendered brief, returned so a caller (and a test) can inspect exactly
   *  what the fresh session was given. Never logged. */
  brief: string | null
}

/** Every effect this composition performs, in one injectable bag. */
export interface FreshVerifierDeps {
  db: Database.Database
  restartFresh: (agent: string) => void
  sessionFor: (agent: string) => string
  sendPrompt: (session: string, prompt: string) => Promise<void>
  briefPathFor: (agent: string) => string
  writeBrief: (path: string, content: string) => void
  /** ISO string for the brief's header. Injected so the composition stays
   *  deterministic under test -- the same reason session-checkpoint takes
   *  `generatedAt` rather than reading a clock. */
  nowIso: () => string
}

export function defaultFreshVerifierDeps(db: Database.Database): FreshVerifierDeps {
  return {
    db,
    restartFresh: restartSessionFresh,
    sessionFor: agentSessionFor,
    sendPrompt: async (session, prompt) => { await sendPromptToSession(session, prompt) },
    briefPathFor: (agent) => join(agentWorkingDir(agent), VERIFIER_BRIEF_FILENAME),
    writeBrief: (path, content) => writeFileSync(path, content, 'utf-8'),
    nowIso: () => new Date().toISOString(),
  }
}

/**
 * The prompt injected into the fresh verifier session.
 *
 * Short on purpose: the CONTEXT is the brief on disk, not this line. It is a
 * separate function from context-guard-runner's `resumePrompt` because that
 * one tells a restarted session to resume the work it was doing -- which is
 * exactly what a fresh verifier must not do (see the note at
 * restartSessionFresh). The only thing the two share is the mechanism.
 */
export function freshVerifierPrompt(workItemId: string, briefPath: string): string {
  return (
    `[FRESH-VERIFIER] Friss sessionben indultál, VERIFIER szerepben a(z) #${workItemId} kártyához. ` +
    `NEM te készítetted ezt a munkát és NEM is javítod. Első és egyetlen forrásod: ${briefPath} ` +
    `-- ez a verifier context packet + a rögzített (immutable) target. ` +
    `A producer sessionjét, transcriptjét, HANDOFF.md-jét SZÁNDÉKOSAN nem kapod meg; ne is keresd. ` +
    `Menj végig az acceptance kritériumokon egyesével, és mindegyikre adj PASS / FAIL / UNKNOWN ítéletet ` +
    `a felhasznált bizonyítékkal együtt. UNKNOWN legitim válasz -- találgatás nem az. ` +
    `Az eredményt kommentként tedd a #${workItemId} kártyára.`
  )
}

/**
 * Dispatch a fresh semantic verifier for one work item (§12.3).
 *
 * Returns a decision in every path, never throws for a refusal: a refusal that
 * arrives as an exception gets caught by a generic handler and read as "the
 * verification failed", which is a different fact from "no verification was
 * owed" or "the packet was malformed".
 *
 * ORDER OF CHECKS, cheapest and most consequential first:
 *   1. §12.4 cost policy -- do not build a packet nobody is paying for;
 *   2. verifier != producer -- §12.3-a, §26 invariant 1;
 *   3. packet validity -- including the producer-history backstop;
 *   4. brief validity -- the shipped checkpoint rules;
 *   5. mint the verifier-role dispatch + persist the packet identity;
 *   6. fresh session, then the prompt.
 * Steps 5 and 6 are in that order deliberately: the identity of a verification
 * that then failed to start is still a fact worth having, while a restarted
 * session with no dispatch row is an execution nobody can attribute.
 */
export async function dispatchFreshVerifier(
  input: FreshVerifierInput,
  deps: FreshVerifierDeps,
): Promise<FreshVerifierResult> {
  const base = {
    packetId: null as string | null,
    packetHash: null as string | null,
    dispatchId: null as string | null,
    briefPath: null as string | null,
    brief: null as string | null,
  }

  const gate = mayDispatchFreshVerifier(input.risk, {
    acceptanceIsSemantic: input.acceptanceIsSemantic,
    policyOverride: input.policyOverride,
  })
  if (!gate.allowed) {
    return {
      ...base, dispatched: false, reasonCode: 'VERIFIER_POLICY_REFUSED',
      detail: gate.detail, policy: gate.policy,
    }
  }

  // §12.3-a. The comparison that makes a verification independent, made BEFORE
  // an identity exists rather than audited afterwards -- an accepted verdict
  // from the producer is not repairable after the fact.
  if (!input.verifierAgent || input.verifierAgent === input.producerAgent) {
    return {
      ...base, dispatched: false, reasonCode: 'VERIFIER_IS_PRODUCER',
      detail:
        `§12.3-a: the verifier must run under an execution identity different from the producer's; ` +
        `both sides name "${input.producerAgent}".`,
      policy: gate.policy,
    }
  }

  const packet = buildVerifierPacket(input)
  const identity = packetIdentity(packet, deps.nowIso())
  const packetValidation = validateVerifierPacket(packet, input.target)
  if (!packetValidation.ok) {
    const problems = [
      ...packetValidation.packet.errors.map(e => `${e.code}@${e.at}`),
      ...packetValidation.errors.map(e => `${e.code}@${e.at}`),
    ]
    return {
      ...base, dispatched: false, reasonCode: 'VERIFIER_PACKET_INVALID',
      packetId: identity.packetId, packetHash: identity.packetHash,
      detail: `The verifier packet is not valid and was NOT sent: ${problems.join(', ')}`,
      policy: gate.policy,
    }
  }

  const brief = renderVerifierBrief({
    packet,
    target: input.target,
    contract: input.contract,
    verifierAgent: input.verifierAgent,
    workItemId: input.workItemId,
    generatedAt: identity.generatedAt ?? deps.nowIso(),
    packetId: identity.packetId,
    packetHash: identity.packetHash,
  })
  const briefValidation = validateVerifierBrief(brief)
  if (!briefValidation.ok) {
    return {
      ...base, dispatched: false, reasonCode: 'VERIFIER_BRIEF_INVALID',
      packetId: identity.packetId, packetHash: identity.packetHash,
      detail: `The verifier brief is not valid and was NOT written: ${briefValidation.errors.map(e => e.code).join(', ')}`,
      policy: gate.policy,
    }
  }

  // §12.3-a, made real: a SECOND dispatch row, role 'verifier', for a different
  // agent. resolveCardRoleAgents() can now answer "who verified this card"
  // with a name instead of the null it has always returned.
  const dispatchId = createDispatchSafe(deps.db, {
    source: 'kanban', role: 'verifier', agent: input.verifierAgent,
    cardId: input.workItemId, project: input.project ?? null,
    ...resolveDispatchIdentitySafe(input.verifierAgent),
  })
  recordPacketMetadataSafe(deps.db, dispatchId, {
    ...derivePacketMetadata(packet, identity.generatedAt),
  })

  const briefPath = deps.briefPathFor(input.verifierAgent)
  try {
    deps.writeBrief(briefPath, brief.markdown)
    // §12.3-b. The session is discarded and rebuilt BEFORE the prompt, so the
    // verifier's context contains the brief and nothing that came before it.
    deps.restartFresh(input.verifierAgent)
    await deps.sendPrompt(deps.sessionFor(input.verifierAgent), freshVerifierPrompt(input.workItemId, briefPath))
  } catch (err) {
    logger.warn({ err, workItemId: input.workItemId, verifier: input.verifierAgent },
      'fresh verifier: session start failed (dispatch row and packet identity were recorded)')
    return {
      ...base, dispatched: false, reasonCode: 'FRESH_SESSION_FAILED',
      packetId: identity.packetId, packetHash: identity.packetHash,
      dispatchId, briefPath, brief: brief.markdown,
      detail: `The fresh verifier session could not be started: ${(err as Error).message}`,
      policy: gate.policy,
    }
  }

  return {
    dispatched: true,
    reasonCode: 'FRESH_VERIFICATION_DISPATCHED',
    detail:
      `Fresh verifier ${input.verifierAgent} dispatched for #${input.workItemId} against pinned target ` +
      `${input.target.ref}, under a verifier-role execution identity distinct from producer ${input.producerAgent}.`,
    policy: gate.policy,
    packetId: identity.packetId,
    packetHash: identity.packetHash,
    dispatchId,
    briefPath,
    brief: brief.markdown,
  }
}
