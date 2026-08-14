export type ApgMode = 'off' | 'observe' | 'assisted' | 'enforced'

export type ApgModeSource =
  | 'global'
  | 'project'
  | 'card'
  /** A `?mode=` preview on this request, clamped to what the configuration
   *  already allows (F-13). Named so the screen can say the mode came from the
   *  URL rather than from any configured scope. */
  | 'request'

export type ApgDisplayState =
  | 'clarification'
  | 'evidence_needed'
  | 'executing'
  | 'verifying'
  | 'decision_needed'
  | 'blocked'
  | 'accepted'
  | 'off'

export type ApgRisk = 'low' | 'medium' | 'high' | 'critical' | 'unknown'

/**
 * How far a work item has travelled towards ACCEPTANCE — which is not the same
 * question as which gate last ran.
 *
 * `gates_passed` and `needs_input` exist because of review finding F-2. Before
 * them the projection said `accepted` whenever the last checkpoint was a PASS on
 * `release_ready` or `runtime_acceptance`, and `returned` whenever the item was
 * waiting for evidence or clarification. Neither event had happened: there was
 * no accepter (the field was structurally null) and nothing had been returned to
 * anyone. §9.2 of the spec forbids exactly this — "NEVER show acceptance from
 * the done status alone" — and §24's "a producer cannot accept its own work"
 * cannot even be checked while nobody is recorded as accepting.
 */
export type ApgAcceptanceStatus =
  | 'not_started'
  | 'produced'
  | 'verifying'
  /** Every required gate passed. NOT acceptance: no principal has accepted it. */
  | 'gates_passed'
  /** A named principal accepted it. Requires `accepter_agent`. */
  | 'accepted'
  /** Waiting on evidence, a decision or a clarification. NOT the same as
   *  `returned`, which claims somebody sent it back. */
  | 'needs_input'
  | 'returned'
  | 'blocked'

/**
 * The seven display labels spec 0.4 §10.4 pins for a claim row, plus an eighth
 * that says the engine has not spoken at all.
 *
 * NOT_RESOLVED_BY_ENGINE is NOT a status the kernel can return; it is the
 * absence of one. §3.7 (No Silent Unknown): "no resolved claim exists for this
 * evidence" and "the engine resolved this claim to UNKNOWN" are different
 * facts, exactly like F-9's unreadable-table-vs-empty-table, and must not
 * collapse onto the same label. Nothing in this repo may mint any of the other
 * seven on its own -- they arrive only by relabelling a status the kernel's
 * claim engine already decided (see APG_KERNEL_VERIFICATION_STATUSES).
 */
export type ApgClaimStatus =
  | 'VERIFIED_CURRENT'
  | 'VERIFIED_HISTORICAL'
  | 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED'
  | 'CONFLICTING_EVIDENCE'
  | 'STALE_OR_SUPERSEDED'
  | 'UNKNOWN'
  | 'BLOCKED_FROM_USE'
  | 'NOT_RESOLVED_BY_ENGINE'

/**
 * The kernel's own seven-value verification vocabulary
 * (`claim_verification.VERIFICATION_STATUSES`), mirrored as a type.
 *
 * Two repos, one contract: `apg-projection-contract.test.ts` asserts this list
 * against the kernel source, so a rename there fails a test here instead of
 * quietly turning one status into another on screen.
 */
export type ApgKernelVerificationStatus =
  | 'VERIFIED_CURRENT'
  | 'VERIFIED_HISTORICAL_ONLY'
  | 'SELF_REPORTED_ONLY'
  | 'STALE'
  | 'UNKNOWN'
  | 'MISSING'
  | 'CONTRADICTED'

export interface ApgDisplayStateMeta {
  key: ApgDisplayState
  labelHu: string
  labelEn: string
  icon: string
  cssClass: string
  descriptionHu: string
  descriptionEn: string
  severity: 'info' | 'warning' | 'danger' | 'success' | 'muted'
}

export const APG_DISPLAY_STATE_META: Record<ApgDisplayState, ApgDisplayStateMeta> = {
  clarification: {
    key: 'clarification',
    labelHu: 'Tisztázás',
    labelEn: 'Clarification',
    icon: '❓',
    cssClass: 'apg-state-clarification',
    descriptionHu: 'A továbblépéshez pontosítás szükséges.',
    descriptionEn: 'Clarification is needed before work can continue.',
    severity: 'info',
  },
  evidence_needed: {
    key: 'evidence_needed',
    labelHu: 'Bizonyíték szükséges',
    labelEn: 'Evidence needed',
    icon: '🔎',
    cssClass: 'apg-state-evidence-needed',
    descriptionHu: 'A rendelkezésre álló bizonyíték még nem teljes.',
    descriptionEn: 'The available evidence is not yet complete.',
    severity: 'warning',
  },
  executing: {
    key: 'executing',
    labelHu: 'Végrehajtás alatt',
    labelEn: 'Executing',
    icon: '⚙️',
    cssClass: 'apg-state-executing',
    descriptionHu: 'A munka végrehajtása folyamatban van.',
    descriptionEn: 'The work is currently being executed.',
    severity: 'info',
  },
  verifying: {
    key: 'verifying',
    labelHu: 'Ellenőrzés alatt',
    labelEn: 'Verifying',
    icon: '✅',
    cssClass: 'apg-state-verifying',
    descriptionHu: 'Az eredmény és a bizonyítékok ellenőrzése folyamatban van.',
    descriptionEn: 'The result and its evidence are being verified.',
    severity: 'info',
  },
  decision_needed: {
    key: 'decision_needed',
    labelHu: 'Döntésre vár',
    labelEn: 'Decision needed',
    icon: '⚖️',
    cssClass: 'apg-state-decision-needed',
    descriptionHu: 'A továbblépéshez tulajdonosi döntés szükséges.',
    descriptionEn: 'An owner decision is needed before work can continue.',
    severity: 'warning',
  },
  blocked: {
    key: 'blocked',
    labelHu: 'Blokkolt',
    labelEn: 'Blocked',
    icon: '⛔',
    cssClass: 'apg-state-blocked',
    descriptionHu: 'Egy sikertelen kontroll megakadályozza a továbblépést.',
    descriptionEn: 'A failed control prevents further progress.',
    severity: 'danger',
  },
  accepted: {
    key: 'accepted',
    labelHu: 'Elfogadva',
    labelEn: 'Accepted',
    icon: '✓',
    cssClass: 'apg-state-accepted',
    descriptionHu: 'A munka ellenőrzött és elfogadott.',
    descriptionEn: 'The work has been verified and accepted.',
    severity: 'success',
  },
  off: {
    key: 'off',
    labelHu: 'APG kikapcsolva',
    labelEn: 'APG disabled',
    icon: '○',
    cssClass: 'apg-state-off',
    descriptionHu: 'Az APG kontrollréteg ezen a hatókörön ki van kapcsolva.',
    descriptionEn: 'The APG control layer is disabled for this scope.',
    severity: 'muted',
  },
}

export interface ApgUiSummary {
  mode: ApgMode
  enabled: boolean
  as_of: string
  projection_version: number
  counts: {
    active: number
    evidence_needed: number
    verifying: number
    decision_needed: number
    blocked: number
    accepted_today: number
    done_not_accepted: number
  }
  attention_items: ApgAttentionItem[]
  /**
   * APG 1.9 §35 (WP6): the live feed's own liveness signal, and the rollout
   * stage that follows from it.
   *
   * §35's second Stage 1 requirement is that the signal be VISIBLE and its
   * stall DETECTABLE, so it rides on the same summary the overview already
   * renders rather than living behind a separate endpoint nobody opens. The
   * field is optional only for the `mode: 'off'` early return, where no kernel
   * is read at all; every other path fills it, including the error paths --
   * "we could not read the feed" is itself a §35 answer (NOT_STARTED /
   * OBSERVE_NOT_FED) and must not be an absent key.
   *
   * WHY IT SITS BESIDE `counts` RATHER THAN IN IT. `counts` is about work
   * items. This is about whether anything is watching them at all, and a zero
   * in `counts` means opposite things depending on it: with a FRESH feed it is
   * "all clear", with a STALLED one it is "not looking".
   */
  feed?: import('./feed-health.js').ApgFeedHealth
  projection_error?: string
}

export interface ApgAttentionItem {
  work_item_id: string
  kanban_card_id: string | null
  project: string | null
  title: string
  display_state: ApgDisplayState
  reason: string
  next_action: string
  age_seconds: number
  deep_link: string
}

export interface ApgUiWorkItemSummary {
  id: string
  kanban_card_id: string | null
  project: string | null
  title: string
  effective_mode: ApgMode
  mode_source: ApgModeSource
  display_state: ApgDisplayState
  internal_state: ApgDisplayState
  risk: ApgRisk
  attention_reason: string | null
  next_action: string
  producer_agent: string | null
  accepter_agent: string | null
  gate_progress: {
    passed: number
    total: number
    blocking_gate: string | null
  }
  claim_counts: {
    total: number
    verified_current: number
    conflicting: number
    unknown: number
    blocked: number
    // Additive to spec 0.4 §6.2's five counters, and load-bearing: without it a
    // work item whose evidence the claim engine has never resolved reads as
    // "0 verified, 0 conflicting, 0 unknown, 0 blocked" -- four zeroes that look
    // like a clean bill of health rather than like silence.
    not_resolved: number
  }
  acceptance_status: ApgAcceptanceStatus
  updated_at: string
}

/**
 * One claim row on the work-item detail page.
 *
 * The first block is what the DASHBOARD knows: the evidence row this claim is
 * attached to. The `kernel_*` block and everything after it is what the KERNEL
 * decided, projected verbatim -- and every one of those fields is OPTIONAL AND
 * OMITTED, never `null`, when the kernel has not supplied it. That distinction
 * is the whole point of the WP2 §10.3-b fix: a hardcoded `superseded_by: null`
 * reads as "the kernel checked and there is no supersede", which was never true
 * -- the kernel had not been asked. An absent key says "not supplied"; a null
 * says "supplied, and it is nothing".
 */
export interface ApgClaim {
  id: string
  text: string
  status: ApgClaimStatus
  allowed_wording: string
  source: string | null
  observed_at: string | null
  receipt_id: string | null
  /** The `claims.id` whose stored resolution produced `status`. */
  kernel_claim_id?: string
  /** The kernel's status string, unmapped, so nothing is lost in translation. */
  kernel_verification_status?: ApgKernelVerificationStatus
  /** `claims.allowed_wording` verbatim -- the kernel's own conservative phrasing. */
  kernel_allowed_wording?: string
  /** Receipt `observed_at`: when the verification actually ran, not when the row was written. */
  verified_at?: string
  /**
   * Who performed the verification. The kernel receipt records a METHOD, not a
   * principal, so this stays absent until WP3 (execution identity) gives the
   * kernel someone to name. It is not `null` here because "no verifier
   * recorded" and "verified by nobody" are not the same statement.
   */
  verifier?: string
  /** §10.3 supersede relation, present only once the kernel stores one. */
  superseded_by?: string
  /** §10.2 currentness dimension, present only once the kernel stores one. */
  currentness?: string
  /** §10.1 product identity, present only once the kernel stores one. */
  product_id?: string
}

export interface ApgWorkItemDetail extends ApgUiWorkItemSummary {
  goal: string
  scope: string
  claims: ApgClaim[]
  evidence_summary: {
    present: number
    unknown: number
    missing: number
  }
  receipts: Array<{
    id: string
    link: string
    ref_kind: string
    status: string
    created_at: string
  }>
  events: ApgEvent[]
  rollback_info: string | null
  side_effect_status: string | null
  source_ids: string[]
  // Same defect channel the summary carries (F-9). A detail page that could not
  // read `claims` must say so rather than render every claim as unresolved and
  // let the reader assume the engine simply had nothing to say.
  projection_error?: string
}

export interface ApgEvent {
  id: string
  type: string
  at: string
  agent: string | null
  work_item_id: string | null
  receipt_id: string | null
  summary: string
  error: boolean
}

export interface ApgScopeOverride {
  scope_type: 'project' | 'kanban_card'
  scope_id: string
  mode: 'inherit' | ApgMode
  updated_at: string
  /**
   * SERVER-STAMPED principal attribution (`session:<user>`, `device:<name>`,
   * `fleet_token:shared`, ...). Before APG 1.9 WP3 this was whatever the
   * request body's `actor` field said -- see apg-principal.ts for why that
   * distinction is the whole point of §11.
   */
  updated_by: string
  reason: string
  /** The caller's self-declared actor name, kept only as a labelled claim. */
  claimed_actor?: string
  /** 'operator' | 'fleet' | 'peer' | 'anonymous' -- see apg-principal.ts. */
  principal_class?: string
  /**
   * §24.0.5's time bound. Present ONLY on a downgrade; once it passes, the
   * scope resolves back to the stricter parent mode with no revoke step.
   */
  expires_at?: string
}
