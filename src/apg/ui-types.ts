export type ApgMode = 'off' | 'observe' | 'assisted' | 'enforced'

export type ApgModeSource = 'global' | 'project' | 'card'

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

export type ApgAcceptanceStatus =
  | 'not_started'
  | 'produced'
  | 'verifying'
  | 'accepted'
  | 'returned'
  | 'blocked'

export type ApgClaimStatus =
  | 'VERIFIED_CURRENT'
  | 'VERIFIED_HISTORICAL'
  | 'SUPPORTED_BUT_NOT_RUNTIME_VERIFIED'
  | 'CONFLICTING_EVIDENCE'
  | 'STALE_OR_SUPERSEDED'
  | 'UNKNOWN'
  | 'BLOCKED_FROM_USE'

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
  }
  acceptance_status: ApgAcceptanceStatus
  updated_at: string
}

export interface ApgClaim {
  id: string
  text: string
  status: ApgClaimStatus
  allowed_wording: string
  source: string | null
  observed_at: string | null
  verified_at: string | null
  verifier: string | null
  receipt_id: string | null
  superseded_by: string | null
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
  updated_by: string
  reason: string
}
