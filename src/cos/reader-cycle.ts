// The sweep that puts the Reader chain on the live path (§10.1 → §10.2 → §12 → §13.1).
//
// WHY THIS FILE EXISTS. Context Builder, Reader and evidence planner were built,
// tested and committed on 2026-08-10, and every one of them had ZERO production
// callers: context-builder.ts was imported only by reader.ts, reader.ts only by
// evidence-planner.ts, and evidence-planner.ts by nothing at all. A closed island
// with no route in from the cycle. Four "done" reports, and the live engine ran
// exactly as it had the day before — while `problems: []` every ten minutes said
// the cycle was healthy, which it was, about the part that ran.
//
// Code that nothing calls is, from the system's point of view, the same as code
// that was never written. So the number this file has to move is not a test
// count: it is a counter in the cycle output saying how many cases the Reader
// actually read.
//
// WHAT IT DOES NOT DO. It does not act. The chain ends at a stored packet, a
// derived plan and an arbitration row. Nothing here writes a case, queues a
// draft or sends anything — §10.2 requires the Reader to be incapable of it, and
// the incapability has to survive being wired up, which is why this module also
// imports no writer, no send flow and no executor.
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { buildCaseContext, contextIntegrityViolations } from './context-builder.js'
import { readCase } from './reader.js'
import type { LlmClient } from './progression-interpreter.js'
import { planFromEvidence } from './evidence-planner.js'
import { arbitrate } from './reader-arbitration.js'
import { killSwitchRefusal } from './kill-switch.js'
import { escalateSensitivity } from './sensitivity.js'
import { egressTierFor, isProviderAllowedForSensitivity, providersAllowedFor } from './provider-data-policy.js'
import type { CaseSensitivity } from './schema.js'
import { staleBlockedCases } from './stale-question-regeneration.js'

/**
 * The most sensitive thing in the context (§10, review #4 N4-1).
 *
 * WHY THIS EXISTS. Wiring the chain created an egress path that did not exist
 * while it was an island: the Reader sends whole email bodies and extracted
 * document text to an EXTERNAL provider. The sensitivity field travelled through
 * the whole system, was printed into the prompt as a label, and decided nothing.
 * §10 of v4.2 says a sensitive case may only be processed by an explicitly
 * allowed model profile — enforced on the SENDING path, absent on the reading one.
 *
 * Declared tier AND content: `egressTierFor` escalates the case's own
 * declaration with what the classifier finds, so an IBAN in a thread lifts the
 * tier even when nobody labelled the case.
 *
 * THE DOMAIN IS AN ARGUMENT, NOT AN ASSUMPTION (review 2026-08-12, T-1). This
 * function used to read every item with the PERSONAL coercer. A corporate case
 * carries `ZST_INTERNAL` and friends, which that coercer does not know, so it
 * fail-closed to HIGHLY_SENSITIVE — and the whole corporate domain was routed to
 * the contracted provider by DATA ABSENCE, with a stored refusal reason that
 * made a false claim about the content. The mapping now lives in
 * provider-data-policy.ts, shared with the enrichment sweep.
 */
export function contextSensitivity(
  domain: 'personal' | 'zst' | string,
  items: Array<{ sensitivity: string; content: string }>,
): CaseSensitivity {
  // Starts at PUBLIC and only ever escalates. Starting fail-closed instead would
  // make an EMPTY context maximally sensitive, which reads as a policy verdict
  // about content nobody has.
  let tier: CaseSensitivity = 'PUBLIC'
  for (const i of items) tier = escalateSensitivity(tier, egressTierFor(domain, i.sensitivity, i.content))
  return tier
}

export interface ReaderPassResult {
  /** Cases the Reader produced a valid packet for. */
  read: number
  /** Cases where a reading was attempted and refused (stored, with the reason). */
  refused: number
  /** §10: cases NOT sent because no configured provider may see their tier.
   *  Counted separately from `refused` because "read: 2" and
   *  "read: 2, sensitivityBlocked: 1" must not look the same. */
  sensitivityBlocked: number
  /** How many cases went to each provider. The routing is the point, so the
   *  split is the evidence — not a log line nobody reads. */
  byProvider: Record<string, number>
  /** §13.1 conflicts: the Reader proposed something the ordering did not allow. */
  conflicts: number
  /** Per-case errors that were not a refusal — a DB failure, a thrown builder. */
  failures: Array<{ caseId: string; error: string }>
  /** Candidates still waiting after this bounded pass. Lets a reader of the
   *  cycle output tell "nothing to do" from "more than the limit". */
  remaining: number
}

export interface ReaderCandidate {
  domain: 'personal' | 'zst'
  caseId: string
  runId: string | null
  policyDecision: string
}

/** §11.2 A fairness. MOVED to `fair-interleave.ts` so the v1.4 proactive sweep
 *  can use the same rule: this module imports the Reader, the Reader imports the
 *  model client, and the model client is on the §15.3 forbidden list — so the
 *  proactive module cannot import from here at all. Re-exported rather than
 *  re-pointed, because the existing callers named this file. */
export { roundRobinByDomain } from './fair-interleave.js'
import { roundRobinByDomain } from './fair-interleave.js'

/**
 * Cases that RAN since they were last read.
 *
 * This is deliberately bound to the progression run rather than to the clock:
 * the §10.8 trigger contract already decided which cases had a reason to think,
 * and a case that was skipped for having nothing new is exactly a case whose
 * previous reading still stands. Without that binding this sweep would re-read
 * 90 unchanged cases every ten minutes — the same waste §10.8 was built to end,
 * one layer up, and this time with a model call attached to each one.
 */
export function casesNeedingReading(db: Database.Database, limit: number): ReaderCandidate[] {
  const out: ReaderCandidate[] = []
  for (const domain of ['personal', 'zst'] as const) {
    try {
      const rows = db.prepare(
        `SELECT r.domain, r.case_id AS caseId, r.progression_run_id AS runId, r.decision AS policyDecision
         FROM case_progression_runs r
         JOIN (
           SELECT case_id, MAX(started_at) AS started_at
           FROM case_progression_runs
           WHERE domain = ? AND status = 'COMPLETED'
           GROUP BY case_id
         ) latest ON latest.case_id = r.case_id AND latest.started_at = r.started_at
         WHERE r.domain = ?
           AND r.started_at > COALESCE((
             SELECT MAX(p.created_at) FROM case_evidence_packets p
             WHERE p.domain = r.domain AND p.case_id = r.case_id
           ), 0)
         ORDER BY r.started_at DESC`,
      ).all(domain, domain) as Array<{ caseId: string; runId: string | null; policyDecision: string }>
      for (const r of rows) {
        out.push({ domain, caseId: r.caseId, runId: r.runId, policyDecision: r.policyDecision ?? 'UNKNOWN' })
      }
    } catch { /* table absent on a fresh store: not a candidate, not an error */ }
  }
  // A STALE-BLOCKED QUESTION IS ALSO A REASON TO READ (owner directive
  // 2026-09-02). The rule above says a case is worth re-reading when a
  // progression run finished after its last packet -- correct, and it left one
  // case out: a question the delivery gate refused as stale needs a FRESH
  // packet, and nothing was going to produce one. Three blocking decisions sat
  // undeliverable for that reason, the oldest twenty-nine days.
  //
  // Put FIRST, ahead of the ordinary candidates: these are cases the owner is
  // already waiting on, and the window (50) is the thing that kept them out.
  // Bounded by MAX_STALE_RETRIES inside staleBlockedCases, so a case that can
  // never be refreshed cannot monopolise the window either.
  const stale = staleBlockedCases(db, limit)
  const staleKey = new Set(stale.map(s => `${s.domain}/${s.caseId}`))
  const staleCandidates: ReaderCandidate[] = stale.map(s => ({
    domain: s.domain, caseId: s.caseId, runId: null, policyDecision: 'STALE_REGENERATION',
  }))
  const rest = out.filter(c => !staleKey.has(`${c.domain}/${c.caseId}`))

  // FAIR, not first-come: see roundRobinByDomain for what slicing a
  // personal-then-zst list costs the corporate namespace.
  return [...staleCandidates, ...roundRobinByDomain(rest, Math.max(0, limit - staleCandidates.length))]
}

/** Store one reading — successful or refused. Both are rows; see the schema
 *  comment for why a refusal that is not written down is worse than useless. */
function storePacket(
  db: Database.Database,
  row: {
    domain: string; caseId: string; runId: string | null; now: number
    contextItems: number; contextExcluded: number; contextUnavailable: number
    packetJson: string | null; planJson: string | null; confidence: number | null
    readerCandidate: string | null; policyResult: string; finalDecision: string | null
    conflictReason: string | null; safeFallback: string | null; decidedBy: string | null
    refusalReason: string | null; model: string | null
  },
): void {
  db.prepare(
    `INSERT INTO case_evidence_packets
     (packet_id, domain, case_id, progression_run_id, created_at,
      context_items, context_excluded, context_unavailable,
      packet_json, plan_json, confidence,
      reader_candidate, policy_result, final_decision, conflict_reason,
      safe_fallback_decision, decided_by, refusal_reason, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), row.domain, row.caseId, row.runId, row.now,
    row.contextItems, row.contextExcluded, row.contextUnavailable,
    row.packetJson, row.planJson, row.confidence,
    row.readerCandidate, row.policyResult, row.finalDecision, row.conflictReason,
    row.safeFallback, row.decidedBy, row.refusalReason, row.model,
  )
}

/**
 * Read up to `limit` cases. One model call each, bounded per cycle.
 *
 * A failure on one case never stops the rest: a single unreadable case must not
 * cost the whole sweep, and the counters say plainly which of the three outcomes
 * each case had.
 */
export interface ReaderRoute {
  client: LlmClient
  provider: string
  model?: string
}

/**
 * Read up to `limit` cases, routing each to a provider its content may go to.
 *
 * Istvan's decision, 2026-08-11: sensitive content goes to a provider that is
 * acceptable on data handling; everything else may go to the cheap one. So this
 * takes TWO routes and picks per case — the gate is not a veto bolted on the
 * front, it is the routing itself.
 *
 * `contracted` may be null (no cleared provider configured), and then sensitive
 * cases are BLOCKED rather than downgraded to the general route. Falling back
 * would defeat the whole rule at exactly the moment it matters.
 */
export async function runReaderPass(
  db: Database.Database,
  routes: { general: ReaderRoute | null; contracted?: ReaderRoute | null },
  opts: { limit?: number; now?: number } = {},
): Promise<ReaderPassResult> {
  const limit = opts.limit ?? 3
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const result: ReaderPassResult = {
    read: 0, refused: 0, sensitivityBlocked: 0, conflicts: 0, byProvider: {}, failures: [], remaining: 0,
  }
  const contracted = routes.contracted ?? null
  const general = routes.general ?? null

  /** The route this content may travel on, or null if none may take it. */
  const routeFor = (tier: CaseSensitivity): ReaderRoute | null => {
    if (general && isProviderAllowedForSensitivity(general.provider, tier)) return general
    if (contracted && isProviderAllowedForSensitivity(contracted.provider, tier)) return contracted
    return null
  }

  // The hard gate is read ONCE per sweep and passed to every arbitration. Read
  // per case it would be a TOCTOU window the size of the sweep; read here, a
  // switch engaged mid-sweep is caught by the next one, and no reading in this
  // one can claim the gate was open when it was not.
  const gate = killSwitchRefusal(db)

  for (const c of casesNeedingReading(db, limit)) {
    try {
      const ctx = buildCaseContext(db, c.domain, c.caseId, now)

      // The builder's own integrity check runs before the model sees anything.
      // A context that violates its own invariants (cross-domain item, missing
      // provenance) is a bug in the builder, and feeding it to the Reader would
      // turn a detectable bug into a plausible-looking packet.
      const violations = contextIntegrityViolations(ctx)
      if (violations.length > 0) {
        result.refused++
        storePacket(db, {
          domain: c.domain, caseId: c.caseId, runId: c.runId, now,
          contextItems: ctx.items.length, contextExcluded: ctx.excluded.length,
          contextUnavailable: ctx.unavailable.length,
          packetJson: null, planJson: null, confidence: null,
          readerCandidate: null, policyResult: c.policyDecision, finalDecision: c.policyDecision,
          conflictReason: null, safeFallback: c.policyDecision, decidedBy: 'INVALID_PACKET',
          refusalReason: `context integrity: ${violations.join('; ')}`, model: null,
        })
        continue
      }

      // §10 SENSITIVITY GATE — the last thing before the content leaves the
      // machine. Everything above this line is local; everything below is a
      // request to a third party.
      const tier = contextSensitivity(c.domain, ctx.items)
      const route = routeFor(tier)
      if (!route) {
        result.sensitivityBlocked++
        const allowed = providersAllowedFor(tier).join(', ')
        storePacket(db, {
          domain: c.domain, caseId: c.caseId, runId: c.runId, now,
          contextItems: ctx.items.length, contextExcluded: ctx.excluded.length,
          contextUnavailable: ctx.unavailable.length,
          packetJson: null, planJson: null, confidence: null,
          readerCandidate: null, policyResult: c.policyDecision, finalDecision: c.policyDecision,
          conflictReason: null, safeFallback: c.policyDecision, decidedBy: 'SENSITIVITY_BLOCKED',
          refusalReason: general || contracted
            ? `§10: ${tier} content needs a provider cleared for it (allowed: ${allowed}); none configured — not sent`
            : `§10: no reader provider configured — nothing sent`,
          model: null,
        })
        continue
      }

      const r = await readCase(route.client, ctx)

      if (!r.ok) {
        result.refused++
        const arb = arbitrate({
          readerCandidate: 'ASK_INFORMATION', confidence: 0,
          policyDecision: c.policyDecision, hardGateRefusal: gate, packetValid: false,
        })
        storePacket(db, {
          domain: c.domain, caseId: c.caseId, runId: c.runId, now,
          contextItems: ctx.items.length, contextExcluded: ctx.excluded.length,
          contextUnavailable: ctx.unavailable.length,
          packetJson: null, planJson: null, confidence: null,
          readerCandidate: null, policyResult: arb.policyResult, finalDecision: arb.finalDecision,
          conflictReason: arb.conflictReason, safeFallback: arb.safeFallbackDecision,
          decidedBy: arb.decidedBy, refusalReason: r.reason, model: route.model ?? null,
        })
        continue
      }

      result.byProvider[route.provider] = (result.byProvider[route.provider] ?? 0) + 1
      const plan = planFromEvidence(r.packet)
      const arb = arbitrate({
        readerCandidate: r.packet.candidateDecision,
        confidence: r.packet.confidence,
        policyDecision: c.policyDecision,
        hardGateRefusal: gate,
        packetValid: true,
      })
      if (arb.conflict) result.conflicts++
      result.read++

      storePacket(db, {
        domain: c.domain, caseId: c.caseId, runId: c.runId, now,
        contextItems: ctx.items.length, contextExcluded: ctx.excluded.length,
        contextUnavailable: ctx.unavailable.length,
        packetJson: JSON.stringify(r.packet), planJson: JSON.stringify(plan),
        confidence: r.packet.confidence,
        readerCandidate: arb.readerCandidate, policyResult: arb.policyResult,
        finalDecision: arb.finalDecision, conflictReason: arb.conflictReason,
        safeFallback: arb.safeFallbackDecision, decidedBy: arb.decidedBy,
        refusalReason: null, model: route.model ?? null,
      })
    } catch (e) {
      result.failures.push({ caseId: `${c.domain}/${c.caseId}`, error: String((e as Error)?.message ?? e) })
    }
  }

  result.remaining = casesNeedingReading(db, 0).length
  return result
}
