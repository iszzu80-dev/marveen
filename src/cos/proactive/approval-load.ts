// §17.5 / §17.6 / §17.7 / §26(24, 25, 27): the approval-load pipeline.
//
// THE TWO SENTENCES THIS FILE IS BUILT BETWEEN, from §17.6:
//
//     NORMAL CAP protects attention
//     DEADLINE ESCAPE protects outcome
//     AUTHORITY GATE remains unchanged
//
// The cap and the escape pull in opposite directions on purpose, and the third
// line is what keeps the argument honest: neither of them touches authority.
// The escape hatch changes WHEN something is shown, never WHAT may be done about
// it. §17.6 says so twice, and the second time in bold: "the deadline escape is
// not auto-approval, not an action-authority escalation, purely a
// presentation/escalation override."
//
// THE INHERITANCE DECISION (§17.6.1) IS THE PART MOST LIKELY TO BE GOT WRONG BY
// KINDNESS. The existing interruption cooldown has two exceptions — an owner
// response releases it, and rephrasing an open question is not a new question —
// and both are sensible there. Neither is inherited here, and
// `owner_response_releases_approval_budget = false` is the normative default.
//
// The reason is worth stating plainly, because "he just answered, surely he can
// look at one more" is a genuinely appealing argument. Answering a question is
// not the same act as approving an action. If one answer released the approval
// budget, a single "yes" to an unrelated question would let a queue of held-back
// approvals through at once — which is exactly the burst the cap exists to
// prevent, arriving through the door marked "he's engaged right now".

import type Database from 'better-sqlite3'
import type { ProactiveDomain } from './types.js'

export type ApprovalDisposition = 'PRESENT' | 'DEFER' | 'BUNDLE' | 'SUPPRESS' | 'DEADLINE_ESCALATED_APPROVAL'

/** §17.6's candidate shape. */
export interface ApprovalCandidate {
  candidateId: string
  domain: ProactiveDomain
  caseId: string
  /** What decision this asks for. Two candidates with the same key are the same
   *  decision and must coalesce (§17.7). */
  decisionKey: string
  materiality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  internalSafeDeadline?: number
  /** The last moment at which presenting this can still change the outcome. */
  latestPresentBy?: number
  queueEnteredAt: number
  priority: number
  /** Set by §15.5. A draft that is not approval-ready never reaches the queue. */
  factualQualityPassed: boolean
  /** Digest of the artifact. An unchanged redraft must not ask again (§17.7). */
  contentDigest: string
}

/** §17.5's initial canary defaults, to be pinned in configuration after the live
 *  audit. Presentation limits — NOT limits on how many internal drafts may be
 *  prepared. The system may keep preparing; it may not keep asking. */
export interface ApprovalBudget {
  maxPerUser24h: number
  maxPerCase24h: number
  /** §17.6: how close to the internal safe deadline triggers the escape. */
  escapeThresholdSec: number
  /** §17.6.1, normative and deliberately false. */
  ownerResponseReleasesApprovalBudget: boolean
  /** §17.7: below this, a draft may not ask for approval on its own. */
  minMaterialityForSoloApproval: 'MEDIUM' | 'HIGH'
}

export const DEFAULT_APPROVAL_BUDGET: ApprovalBudget = {
  maxPerUser24h: 2,
  maxPerCase24h: 1,
  escapeThresholdSec: 48 * 3600,
  ownerResponseReleasesApprovalBudget: false,
  minMaterialityForSoloApproval: 'MEDIUM',
}

export function ensureApprovalLoadSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_approval_presentations (
      candidate_id     TEXT PRIMARY KEY,
      domain           TEXT NOT NULL,
      case_id          TEXT NOT NULL,
      decision_key     TEXT NOT NULL,
      content_digest   TEXT NOT NULL,
      disposition      TEXT NOT NULL,
      /* §17.6: the audited reason. An escape that is not recorded as an escape
         is indistinguishable from a cap that was never enforced. */
      reason           TEXT NOT NULL,
      bundle_id        TEXT,
      presented_at     INTEGER,
      decided_at       INTEGER,
      created_at       INTEGER NOT NULL,
      CHECK (domain IN ('personal','zst'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_papprove_user ON proactive_approval_presentations(presented_at)
           WHERE presented_at IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_papprove_case ON proactive_approval_presentations(domain, case_id, presented_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_papprove_decision ON proactive_approval_presentations(decision_key)`)
}

const DAY = 86400
const MATERIALITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const

export interface Decision {
  candidateId: string
  disposition: ApprovalDisposition
  reason: string
  bundleId?: string
}

export interface QueueResult {
  decisions: Decision[]
  /** §17.8 backpressure. */
  presentedCount: number
  deferredCount: number
  suppressedCount: number
  bundledCount: number
  escalatedCount: number
  /** Age of the oldest still-deferred candidate. */
  oldestDeferredAgeSec: number
  /** §17.6: the single P0 bundle, when several candidates had to escape at
   *  once. Null when there was no such burst. */
  burstBundleId: string | null
}

/**
 * §17.5's pipeline, in the spec's own order.
 *
 * The order is not arbitrary. Quality first, so a bad draft never occupies a
 * budget slot. Coalescing before the cooldown, so two drafts about one decision
 * do not consume two slots. The cap last of all, so it is applied to the things
 * that genuinely deserve a slot rather than to whatever arrived first.
 */
export function planApprovalQueue(
  db: Database.Database,
  candidates: readonly ApprovalCandidate[],
  now: number,
  budget: ApprovalBudget = DEFAULT_APPROVAL_BUDGET,
): QueueResult {
  const decisions: Decision[] = []
  const decide = (c: ApprovalCandidate, disposition: ApprovalDisposition, reason: string, bundleId?: string): void => {
    decisions.push({ candidateId: c.candidateId, disposition, reason, bundleId })
  }

  // 1. §15.5 factual-quality gate. Mandatory before presentation (§17.7), and
  //    first here so a draft that could never be approved does not displace one
  //    that could.
  const quality = candidates.filter(c => {
    if (!c.factualQualityPassed) {
      decide(c, 'SUPPRESS', 'a §15.5 tényszerűségi kapun nem ment át — jóváhagyásra nem terjeszthető elő')
      return false
    }
    return true
  })

  // 2. Duplicate / same-decision coalescing (§17.5, §17.7).
  const seenDigests = presentedDigests(db)
  const byDecision = new Map<string, ApprovalCandidate[]>()
  const survivors: ApprovalCandidate[] = []
  for (const c of quality) {
    // §17.6.1: `approval_rephrase_does_not_create_new_approval_candidate`. An
    // unchanged redraft is the same ask wearing a new id, and letting it through
    // would turn the cap into a formality — anyone can re-render a draft.
    if (seenDigests.has(c.contentDigest)) {
      decide(c, 'SUPPRESS', 'változatlan tartalmú újra-előterjesztés — nem új jóváhagyási kérés (§17.6.1)')
      continue
    }
    const list = byDecision.get(c.decisionKey) ?? []
    list.push(c)
    byDecision.set(c.decisionKey, list)
  }
  let bundleSeq = 0
  for (const [key, list] of byDecision) {
    if (list.length === 1) { survivors.push(list[0]); continue }
    // §17.7: drafts belonging to one decision coalesce into one package. The
    // most material one carries it; the rest are BUNDLE, not SUPPRESS, because
    // "folded into another ask" and "dropped" are different facts and only one
    // of them is recoverable.
    const sorted = [...list].sort((a, b) =>
      MATERIALITY_RANK[b.materiality] - MATERIALITY_RANK[a.materiality] || a.priority - b.priority)
    const bundleId = `bundle-${key}-${bundleSeq++}`
    survivors.push(sorted[0])
    for (const c of sorted.slice(1)) {
      decide(c, 'BUNDLE', `egy döntéshez tartozik (${key}) — egy csomagba vonva`, bundleId)
    }
  }

  // 3. §17.7: a low-materiality draft may not ask for approval on its own.
  const material = survivors.filter(c => {
    if (MATERIALITY_RANK[c.materiality] < MATERIALITY_RANK[budget.minMaterialityForSoloApproval]) {
      decide(c, 'SUPPRESS', 'alacsony materialitás — önálló jóváhagyást nem kérhet (§17.7)')
      return false
    }
    return true
  })

  // 4. The deadline escape is computed BEFORE the cap, because §17.6 says the
  //    budget "must not override the deadline engine". Computing it after would
  //    make the escape a special case of the cap, which is the opposite
  //    relationship.
  const escaping = material.filter(c => needsEscape(c, now, budget))
  const normal = material.filter(c => !needsEscape(c, now, budget))

  // 5. §17.5's caps, applied to what is left.
  const userUsed = presentedInWindow(db, now - DAY)
  let userBudget = Math.max(0, budget.maxPerUser24h - userUsed)
  const caseUsed = new Map<string, number>()

  const ordered = [...normal].sort((a, b) =>
    MATERIALITY_RANK[b.materiality] - MATERIALITY_RANK[a.materiality]
    || a.priority - b.priority
    || a.queueEnteredAt - b.queueEnteredAt)

  for (const c of ordered) {
    const caseKey = `${c.domain}/${c.caseId}`
    const usedForCase = caseUsed.get(caseKey) ?? presentedForCaseInWindow(db, c.domain, c.caseId, now - DAY)
    if (usedForCase >= budget.maxPerCase24h) {
      decide(c, 'DEFER', `ügyenkénti 24 órás jóváhagyási keret betelt (${budget.maxPerCase24h})`)
      continue
    }
    if (userBudget <= 0) {
      decide(c, 'DEFER', `felhasználói 24 órás jóváhagyási keret betelt (${budget.maxPerUser24h})`)
      continue
    }
    userBudget--
    caseUsed.set(caseKey, usedForCase + 1)
    decide(c, 'PRESENT', 'a kereten belül előterjeszthető')
  }

  // 6. §17.6's burst rule. Several candidates forced past the cap at once must
  //    NOT be hidden — but neither may they arrive as a burst of separate
  //    prompts, which is the very thing the cap protects against. One bundled
  //    P0 interruption says both facts at once: there are more
  //    authority-required decisions open than the normal frame allows, and at
  //    least one internal safe deadline is running out.
  const burstBundleId = escaping.length > 1 ? `escape-burst-${escaping[0].candidateId}` : null
  for (const c of escaping) {
    decide(c, 'DEADLINE_ESCALATED_APPROVAL',
      escapeReason(c, now, budget)
      + (burstBundleId ? ' — egyetlen P0 kötegbe vonva, mert több jelölt egyszerre kényszerül a keret fölé' : ''),
      burstBundleId ?? undefined)
  }

  const count = (d: ApprovalDisposition): number => decisions.filter(x => x.disposition === d).length
  const deferred = decisions.filter(d => d.disposition === 'DEFER')
  const oldest = deferred.length
    ? Math.max(...deferred.map(d => now - (candidates.find(c => c.candidateId === d.candidateId)?.queueEnteredAt ?? now)))
    : 0

  return {
    decisions,
    presentedCount: count('PRESENT'),
    deferredCount: deferred.length,
    suppressedCount: count('SUPPRESS'),
    bundledCount: count('BUNDLE'),
    escalatedCount: count('DEADLINE_ESCALATED_APPROVAL'),
    oldestDeferredAgeSec: Math.max(0, oldest),
    burstBundleId,
  }
}

/** §17.6's condition, verbatim: past the latest-present-by, OR close enough to
 *  the internal safe deadline. */
export function needsEscape(c: ApprovalCandidate, now: number, budget: ApprovalBudget): boolean {
  if (c.latestPresentBy != null && now >= c.latestPresentBy) return true
  if (c.internalSafeDeadline != null && c.internalSafeDeadline - now <= budget.escapeThresholdSec) return true
  return false
}

function escapeReason(c: ApprovalCandidate, now: number, budget: ApprovalBudget): string {
  if (c.latestPresentBy != null && now >= c.latestPresentBy) {
    return `a legkésőbbi előterjesztési idő (${c.latestPresentBy}) elmúlt — a keret nem írhatja felül a határidőt (§17.6)`
  }
  return `a belső biztonsági határidő ${Math.max(0, (c.internalSafeDeadline ?? 0) - now)} másodpercen belül — `
    + 'keret fölötti felszínre hozás (§17.6)'
}

function presentedInWindow(db: Database.Database, since: number): number {
  try {
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM proactive_approval_presentations
        WHERE presented_at IS NOT NULL AND presented_at >= ?
          AND disposition IN ('PRESENT','DEADLINE_ESCALATED_APPROVAL')`,
    ).get(since) as { n: number }).n
  } catch { return 0 }
}

function presentedForCaseInWindow(db: Database.Database, domain: string, caseId: string, since: number): number {
  try {
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM proactive_approval_presentations
        WHERE domain = ? AND case_id = ? AND presented_at IS NOT NULL AND presented_at >= ?
          AND disposition IN ('PRESENT','DEADLINE_ESCALATED_APPROVAL')`,
    ).get(domain, caseId, since) as { n: number }).n
  } catch { return 0 }
}

function presentedDigests(db: Database.Database): Set<string> {
  try {
    return new Set((db.prepare(
      `SELECT DISTINCT content_digest AS d FROM proactive_approval_presentations
        WHERE disposition IN ('PRESENT','DEADLINE_ESCALATED_APPROVAL')`,
    ).all() as Array<{ d: string }>).map(r => r.d))
  } catch { return new Set() }
}

/** Write the outcome. `presented_at` is set only for the two dispositions that
 *  actually reach the owner — DEFER and BUNDLE consume no attention and must not
 *  consume budget either. */
export function recordDecisions(
  db: Database.Database,
  candidates: readonly ApprovalCandidate[],
  result: QueueResult,
  now: number,
): void {
  const byId = new Map(candidates.map(c => [c.candidateId, c]))
  const ins = db.prepare(
    `INSERT INTO proactive_approval_presentations
       (candidate_id, domain, case_id, decision_key, content_digest, disposition, reason, bundle_id, presented_at, created_at)
     VALUES (@id, @domain, @caseId, @key, @digest, @disposition, @reason, @bundle, @presentedAt, @now)
     ON CONFLICT(candidate_id) DO UPDATE SET
       disposition = @disposition, reason = @reason, bundle_id = @bundle,
       presented_at = COALESCE(proactive_approval_presentations.presented_at, @presentedAt)`,
  )
  const tx = db.transaction(() => {
    for (const d of result.decisions) {
      const c = byId.get(d.candidateId)
      if (!c) continue
      ins.run({
        id: c.candidateId, domain: c.domain, caseId: c.caseId, key: c.decisionKey,
        digest: c.contentDigest, disposition: d.disposition, reason: d.reason,
        bundle: d.bundleId ?? null,
        presentedAt: d.disposition === 'PRESENT' || d.disposition === 'DEADLINE_ESCALATED_APPROVAL' ? now : null,
        now,
      })
    }
  })
  tx()
}

/**
 * §17.6.1, as an executable statement rather than a paragraph.
 *
 * Every exception the interruption cooldown has, with an explicit INHERIT /
 * DO_NOT_INHERIT / ADAPT decision for the approval channel. The spec requires
 * the decision to be explicit precisely because the default reading is
 * inheritance — the two channels look alike, and "it works for interruptions"
 * is a sentence nobody argues with.
 */
export const COOLDOWN_EXCEPTION_INHERITANCE: ReadonlyArray<{
  exception: string
  interruptionBehaviour: string
  approvalDecision: 'INHERIT' | 'DO_NOT_INHERIT' | 'ADAPT'
  rationale: string
}> = [
  {
    exception: 'owner_response_releases_cooldown',
    interruptionBehaviour: 'egy tulajdonosi válasz azonnal feloldja az interruption cooldownt',
    approvalDecision: 'DO_NOT_INHERIT',
    rationale:
      'Egy kérdés megválaszolása nem ugyanaz a cselekvés, mint egy művelet jóváhagyása. Ha egy '
      + 'válasz feloldaná a jóváhagyási keretet, egyetlen "igen" egy nem kapcsolódó kérdésre '
      + 'egyszerre engedné át a visszatartott jóváhagyások sorát — pontosan az a löket, ami ellen a '
      + 'keret készült, csak azon az ajtón érkezve, amire az van írva, hogy "most úgyis figyel".',
  },
  {
    exception: 'question_rephrase_is_not_a_new_question',
    interruptionBehaviour: 'egy nyitott kérdés újrafogalmazása nem számít új kérdésnek',
    approvalDecision: 'ADAPT',
    rationale:
      'Az elv átjön, a mechanizmusa nem. Az interruption oldalon a kérdés HASH-e dönti el; itt a '
      + 'draft TARTALMÁNAK digestje, mert egy átfogalmazott jóváhagyási kérés akkor is ugyanaz a '
      + 'kérés, ha a szövege más — és akkor NEM ugyanaz, ha a tartalma változott.',
  },
]
