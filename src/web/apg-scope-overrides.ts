// This store is Marveen's own UI-side configuration: it records which mode
// the dashboard shows for each scope, plus a UI action audit trail. It is
// explicitly not APG kernel sidecar domain truth (owner spec section 1.4):
// the sidecar remains the sole authority for APG claims, receipts, evidence,
// and other domain state.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import type {
  ApgMode,
  ApgModeSource,
  ApgScopeOverride,
} from '../apg/ui-types.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  type ApgPrincipal,
  isOperatorPrincipal,
  resolveApgPrincipal,
} from './apg-principal.js'
import { getDb } from '../db.js'
import { listCardProducerAgents, listProjectProducerAgents } from '../costops/dispatch.js'

const OVERRIDES_PATH = join(PROJECT_ROOT, 'store', 'apg-scope-overrides.json')
const AUDIT_PATH = join(PROJECT_ROOT, 'store', 'apg-ui-audit.jsonl')
const APG_MODES: readonly ApgMode[] = ['off', 'observe', 'assisted', 'enforced']
const STORED_MODES: ReadonlyArray<ApgScopeOverride['mode']> = ['inherit', ...APG_MODES]
const KANBAN_CARD_ID_PATTERN = /^[0-9a-f]{8}$/

// §24.0.5: "Owner/operator emergency override külön auditable safety action
// lehet, de: indok kötelező; időben/scope-ban korlátozott". A downgrade is
// therefore never permanent -- it carries an expiry, and resolveEffectiveApgMode
// stops honouring it the moment that passes (back to the parent mode, i.e. the
// stricter one: expiry fails CLOSED). Twelve hours is the longest single
// operator shift this fleet runs; anything longer is a policy change, which
// §24.0.3's gate maturity record is the mechanism for -- not this endpoint.
export const MAX_DOWNGRADE_TTL_MINUTES = 12 * 60
export const DEFAULT_DOWNGRADE_TTL_MINUTES = 60

export interface StoredScopeOverride extends ApgScopeOverride {}

interface ScopeOverrideFile {
  overrides: StoredScopeOverride[]
}

function isStoredScopeOverride(value: unknown): value is StoredScopeOverride {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  // The §11/§24.0.5 provenance fields are validated as OPTIONAL: a row written
  // before this change is still a legitimate override, not a corrupt file that
  // silently empties the whole store (readScopeOverrideFile drops everything if
  // one row fails). Their absence is itself informative -- listScopeOverrides
  // surfaces it, and no code treats a missing principal_class as an operator.
  return (
    (row.scope_type === 'project' || row.scope_type === 'kanban_card')
    && typeof row.scope_id === 'string'
    && STORED_MODES.includes(row.mode as ApgScopeOverride['mode'])
    && typeof row.updated_at === 'string'
    && typeof row.updated_by === 'string'
    && typeof row.reason === 'string'
    && (row.expires_at === undefined || typeof row.expires_at === 'string')
    && (row.claimed_actor === undefined || typeof row.claimed_actor === 'string')
    && (row.principal_class === undefined || typeof row.principal_class === 'string')
  )
}

function readScopeOverrideFile(): ScopeOverrideFile {
  try {
    if (!existsSync(OVERRIDES_PATH)) return { overrides: [] }
    const parsed = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { overrides: [] }
    }
    const overrides = (parsed as Record<string, unknown>).overrides
    if (!Array.isArray(overrides) || !overrides.every(isStoredScopeOverride)) {
      return { overrides: [] }
    }
    return { overrides }
  } catch {
    return { overrides: [] }
  }
}

function readGlobalMode(): ApgMode {
  const value = String(getEffectiveSettingValue('APG_MODE'))
  return APG_MODES.includes(value as ApgMode) ? value as ApgMode : 'off'
}

function validateScopeId(
  scopeType: 'project' | 'kanban_card',
  scopeId: string,
): string | null {
  if (!scopeId.trim()) return 'scope_id is required'
  if (scopeType === 'kanban_card' && !KANBAN_CARD_ID_PATTERN.test(scopeId.trim())) {
    return 'scope_id must be an 8-character lowercase hexadecimal kanban card id'
  }
  return null
}

export function listScopeOverrides(): StoredScopeOverride[] {
  return readScopeOverrideFile().overrides
}

/**
 * The mode this scope currently answers to -- the STRICTER of the parent
 * (global/product) mode and any override already standing on this exact scope.
 *
 * Both halves are load-bearing. Comparing only against the parent would miss
 * "card was explicitly raised to enforced, its own producer now sets it back to
 * observe" -- the self-downgrade §24.0.5 names, which never touches the parent.
 * Comparing only against the existing override would miss the §24.0.5 headline
 * case: an ENFORCED product being taken down to OBSERVE on a scope that has no
 * override yet.
 */
function currentAuthorityMode(
  scopeType: 'project' | 'kanban_card',
  scopeId: string,
  overrides: StoredScopeOverride[],
): ApgMode {
  const parent = readGlobalMode()
  const existing = overrides.find((row) =>
    row.scope_type === scopeType && row.scope_id === scopeId && !isExpired(row))
  if (!existing || existing.mode === 'inherit') return parent
  return APG_MODES.indexOf(existing.mode) > APG_MODES.indexOf(parent) ? existing.mode : parent
}

/**
 * Who may be asked "are you the producer of this scope?", and the answer.
 * Injected so the policy is testable without a DB, and so a lookup FAULT is a
 * distinguishable third answer (`null`) rather than an empty producer list --
 * an empty list would silently mean "nobody produced here, downgrade away".
 */
export interface ScopeOverrideDeps {
  /** Producer agents for this scope, or null when the lookup itself failed. */
  producersFor: (scopeType: 'project' | 'kanban_card', scopeId: string) => string[] | null
  now: () => Date
}

export function defaultScopeOverrideDeps(): ScopeOverrideDeps {
  return {
    producersFor: (scopeType, scopeId) => {
      try {
        const db = getDb()
        return scopeType === 'kanban_card'
          ? listCardProducerAgents(db, scopeId)
          : listProjectProducerAgents(db, scopeId)
      } catch (err) {
        // Deliberately NOT [] -- see the interface note. The caller decides what
        // an unknown producer set means per §25's mode ladder.
        logger.warn({ err, scopeType, scopeId }, 'apg scope override: producer lookup failed')
        return null
      }
    },
    now: () => new Date(),
  }
}

export interface SetScopeOverrideInput {
  scope_type: 'project' | 'kanban_card'
  scope_id: string
  mode: string
  /** The caller's SELF-DECLARED actor name. Never becomes `updated_by`. */
  claimed_actor: string
  reason: string
  /** Requested downgrade lifetime; clamped to MAX_DOWNGRADE_TTL_MINUTES. */
  ttl_minutes?: number | null
}

export type SetScopeOverrideResult =
  | { ok: true; override: StoredScopeOverride }
  | { ok: false; error: string; status?: number }

/**
 * Write one scope override, under the §24.0.5 authority rules.
 *
 * The 1.8 audit (§3.2) found this endpoint was the fleet's own back door:
 * every dispatched agent holds the dashboard bearer token, so ANY agent could
 * PUT its own card out of enforced mode with a free-text excuse, and the stored
 * `updated_by` was whatever the request body said. §24.0.5 forbids exactly that
 * shape -- "Producer, worker vagy a futó chain nem teheti: ENFORCED product ->
 * whole chain OBSERVE".
 *
 * The rules, in the order they are applied:
 *
 *   1. RAISING enforcement, or returning to `inherit`, needs nothing new. Only
 *      weakening is an authority act; making a scope stricter cannot be
 *      self-serving, and gating it would just teach operators to route around
 *      the endpoint.
 *   2. A downgrade needs a reason (unchanged, and checked first so an
 *      unauthorised caller still gets the more useful of the two errors).
 *   3. A downgrade needs an OPERATOR principal -- a browser session or a device
 *      key. The fleet-shared bearer token is refused, which is the actual fix:
 *      an agent cannot mint a session cookie or a device key, so the class of
 *      caller §24.0.5 names is now structurally unable to perform the act. This
 *      is the emergency-override lane §24.0.5 permits, not a general one.
 *   4. A downgrade may not come from the scope's own PRODUCER. This second
 *      check is best-effort by construction and is documented as such: it
 *      compares the claimed actor, which a lying client controls. It exists for
 *      the same reason the approvals self-approval guard does -- it catches the
 *      naive case -- and it is NOT what makes rule 3 hold.
 *   5. A downgrade is BOUNDED IN TIME. §24.0.5 requires it; the stored row
 *      carries `expires_at`, and resolveEffectiveApgMode ignores the row once
 *      that passes, so the scope returns to the stricter parent mode on its own.
 *   6. The audit row records the principal, the class, the claimed actor, the
 *      reason and the expiry -- "who, and on what basis".
 *
 * What it does NOT do, per §24.0.5's last two bullets: it writes no gate
 * maturity evidence and creates no precedent. This store is Marveen's UI-side
 * mode record; gate maturity (§24.0.3) lives in the kernel and is untouched.
 */
export function setScopeOverride(
  input: SetScopeOverrideInput,
  principal: ApgPrincipal = resolveApgPrincipal(undefined),
  deps: ScopeOverrideDeps = defaultScopeOverrideDeps(),
): SetScopeOverrideResult {
  if (input.scope_type !== 'project' && input.scope_type !== 'kanban_card') {
    return { ok: false, error: 'scope_type must be project or kanban_card' }
  }
  if (typeof input.scope_id !== 'string') {
    return { ok: false, error: 'scope_id is required' }
  }
  const scopeId = input.scope_id.trim()
  const scopeIdError = validateScopeId(input.scope_type, scopeId)
  if (scopeIdError) return { ok: false, error: scopeIdError }
  if (!STORED_MODES.includes(input.mode as ApgScopeOverride['mode'])) {
    return {
      ok: false,
      error: 'mode must be inherit, off, observe, assisted, or enforced',
    }
  }
  const claimedActor = typeof input.claimed_actor === 'string' ? input.claimed_actor.trim() : ''
  if (!claimedActor) {
    return { ok: false, error: 'actor is required' }
  }

  const mode = input.mode as ApgScopeOverride['mode']
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const file = readScopeOverrideFile()
  const authorityMode = currentAuthorityMode(input.scope_type, scopeId, file.overrides)
  const isDowngrade = (
    mode !== 'inherit'
    && APG_MODES.indexOf(mode) < APG_MODES.indexOf(authorityMode)
  )

  let expiresAt: string | null = null
  let producerCheck: 'clear' | 'unknown' = 'clear'
  if (isDowngrade) {
    // 2. Reason first: an operator who forgot the reason and an agent that has
    //    no business here both get an accurate error, in that order.
    if (!reason) {
      return {
        ok: false,
        error: `reason is required when downgrading from ${authorityMode} mode`,
      }
    }
    // 3. The rule that actually holds.
    if (!isOperatorPrincipal(principal)) {
      writeApgAuditEvent('scope_override_downgrade_refused', {
        scope_type: input.scope_type,
        scope_id: scopeId,
        from_mode: authorityMode,
        to_mode: mode,
        principal: principal.attribution,
        principal_class: principal.class,
        claimed_actor: claimedActor,
        reason,
        refusal: 'non_operator_principal',
      })
      return {
        ok: false,
        status: 403,
        error:
          `APG 1.9 §24.0.5: downgrading ${input.scope_type} scope out of ${authorityMode} mode `
          + 'requires an operator principal (browser session or enrolled device key). '
          + 'The fleet-shared dashboard token is an agent principal and cannot downgrade its own scope.',
      }
    }
    // 4. Self-downgrade by the producer. Best-effort (claimed actor), plus a
    //    fail-CLOSED branch for the case where we cannot answer the question at
    //    all: §25 says an enforced-mode control-plane failure fails closed, and
    //    "is this caller the producer?" is precisely a required control here.
    const producers = deps.producersFor(input.scope_type, scopeId)
    if (producers === null) {
      producerCheck = 'unknown'
      if (authorityMode === 'enforced') {
        writeApgAuditEvent('scope_override_downgrade_refused', {
          scope_type: input.scope_type,
          scope_id: scopeId,
          from_mode: authorityMode,
          to_mode: mode,
          principal: principal.attribution,
          principal_class: principal.class,
          claimed_actor: claimedActor,
          reason,
          refusal: 'producer_lookup_unavailable',
        })
        return {
          ok: false,
          status: 403,
          error:
            'APG 1.9 §25: the producer check for this scope could not run, and the scope is '
            + 'enforced -- a required control failure fails closed. Retry once the dispatch '
            + 'store is readable.',
        }
      }
    } else if (producers.some((agent) => agent === claimedActor)) {
      writeApgAuditEvent('scope_override_downgrade_refused', {
        scope_type: input.scope_type,
        scope_id: scopeId,
        from_mode: authorityMode,
        to_mode: mode,
        principal: principal.attribution,
        principal_class: principal.class,
        claimed_actor: claimedActor,
        reason,
        refusal: 'producer_self_downgrade',
      })
      return {
        ok: false,
        status: 403,
        error:
          `APG 1.9 §24.0.5: "${claimedActor}" is a producer on this scope and a producer may not `
          + 'downgrade the scope it produced into. A different principal must make this call.',
      }
    }
    // 5. Bounded in time.
    const requested = typeof input.ttl_minutes === 'number' && Number.isFinite(input.ttl_minutes)
      ? Math.floor(input.ttl_minutes)
      : DEFAULT_DOWNGRADE_TTL_MINUTES
    const ttl = Math.min(MAX_DOWNGRADE_TTL_MINUTES, Math.max(1, requested))
    expiresAt = new Date(deps.now().getTime() + ttl * 60_000).toISOString()
  }

  const override: StoredScopeOverride = {
    scope_type: input.scope_type,
    scope_id: scopeId,
    mode,
    updated_at: deps.now().toISOString(),
    // SERVER-STAMPED (§11.4's shape, applied to the mode store): `updated_by`
    // is the resolved principal, never the body's actor string. The body's
    // value is kept alongside it, explicitly labelled as a claim.
    updated_by: principal.attribution,
    claimed_actor: claimedActor,
    principal_class: principal.class,
    reason,
    ...(expiresAt !== null ? { expires_at: expiresAt } : {}),
  }
  const existingIndex = file.overrides.findIndex((row) =>
    row.scope_type === override.scope_type && row.scope_id === override.scope_id)
  if (existingIndex >= 0) {
    file.overrides[existingIndex] = override
  } else {
    file.overrides.push(override)
  }

  try {
    atomicWriteFileSync(OVERRIDES_PATH, JSON.stringify(file, null, 2) + '\n')
  } catch {
    return { ok: false, error: 'Failed to write scope override' }
  }
  writeApgAuditEvent('scope_override_set', {
    ...override,
    principal: principal.attribution,
    principal_kind: principal.kind,
    human_attestation: principal.humanAttestation,
    from_mode: authorityMode,
    downgrade: isDowngrade,
    // Recorded rather than swallowed: a downgrade written while the producer
    // set was unknowable is a weaker audit row than one written after a clean
    // producer check, and §3.7 (No Silent Unknown) says so out loud.
    producer_check: isDowngrade ? producerCheck : 'not_applicable',
  })
  return { ok: true, override }
}

/**
 * Remove an override. Deleting one is normally the SAFE direction -- the scope
 * falls back to the parent mode -- but not always: deleting an override that
 * RAISED a scope above the parent weakens that scope, which is the §24.0.5 act
 * under a different verb. So the same operator-principal rule applies to
 * exactly that case, and to nothing else.
 */
export function deleteScopeOverride(
  scopeType: 'project' | 'kanban_card',
  scopeId: string,
  claimedActor: string,
  reason: string,
  principal: ApgPrincipal = resolveApgPrincipal(undefined),
): { ok: true } | { ok: false; error: string; status?: number } {
  if (scopeType !== 'project' && scopeType !== 'kanban_card') {
    return { ok: false, error: 'scope_type must be project or kanban_card' }
  }
  if (typeof scopeId !== 'string') return { ok: false, error: 'scope_id is required' }
  const normalizedScopeId = scopeId.trim()
  const scopeIdError = validateScopeId(scopeType, normalizedScopeId)
  if (scopeIdError) return { ok: false, error: scopeIdError }
  if (typeof claimedActor !== 'string' || !claimedActor.trim()) {
    return { ok: false, error: 'updated_by is required' }
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return { ok: false, error: 'reason is required' }
  }

  const file = readScopeOverrideFile()
  const existingIndex = file.overrides.findIndex((row) =>
    row.scope_type === scopeType && row.scope_id === normalizedScopeId)
  if (existingIndex < 0) return { ok: false, error: 'Scope override not found' }
  const target = file.overrides[existingIndex]

  const parent = readGlobalMode()
  const weakensScope = (
    target.mode !== 'inherit'
    && !isExpired(target)
    && APG_MODES.indexOf(target.mode) > APG_MODES.indexOf(parent)
  )
  if (weakensScope && !isOperatorPrincipal(principal)) {
    writeApgAuditEvent('scope_override_downgrade_refused', {
      scope_type: scopeType,
      scope_id: normalizedScopeId,
      from_mode: target.mode,
      to_mode: parent,
      principal: principal.attribution,
      principal_class: principal.class,
      claimed_actor: claimedActor.trim(),
      reason: reason.trim(),
      refusal: 'non_operator_principal_delete',
    })
    return {
      ok: false,
      status: 403,
      error:
        `APG 1.9 §24.0.5: deleting this override would drop the scope from ${target.mode} to `
        + `${parent}. That requires an operator principal (browser session or enrolled device key).`,
    }
  }

  const [deleted] = file.overrides.splice(existingIndex, 1)

  try {
    atomicWriteFileSync(OVERRIDES_PATH, JSON.stringify(file, null, 2) + '\n')
  } catch {
    return { ok: false, error: 'Failed to delete scope override' }
  }
  writeApgAuditEvent('scope_override_deleted', {
    override: deleted,
    updated_by: principal.attribution,
    principal_class: principal.class,
    claimed_actor: claimedActor.trim(),
    reason: reason.trim(),
  })
  return { ok: true }
}

/**
 * Has this override's §24.0.5 time bound passed? An unparseable `expires_at` is
 * treated as EXPIRED, not as "no expiry": the field only ever appears on a
 * downgrade, so garbage in it must drop the scope back to the stricter parent
 * mode rather than leave a permanent downgrade behind.
 */
export function isExpired(row: StoredScopeOverride, now: Date = new Date()): boolean {
  if (row.expires_at === undefined) return false
  const at = Date.parse(row.expires_at)
  if (!Number.isFinite(at)) return true
  return at <= now.getTime()
}

export function resolveEffectiveApgMode(
  project: string | null,
  kanbanCardId: string | null,
  now: Date = new Date(),
): { mode: ApgMode; source: ApgModeSource } {
  const globalMode = readGlobalMode()
  if (globalMode === 'off') return { mode: 'off', source: 'global' }

  // An expired downgrade stops applying on its own -- §24.0.5's "időben
  // korlátozott" is only real if nothing has to remember to revoke it. The
  // expiry direction is always back toward the stricter parent mode, so an
  // expiry that fires unexpectedly can only over-enforce, never under-enforce.
  const overrides = readScopeOverrideFile().overrides.filter((row) => !isExpired(row, now))
  if (kanbanCardId) {
    const cardOverride = overrides.find((row) =>
      row.scope_type === 'kanban_card' && row.scope_id === kanbanCardId)
    if (cardOverride && cardOverride.mode !== 'inherit') {
      return { mode: cardOverride.mode, source: 'card' }
    }
  }
  if (project) {
    const projectOverride = overrides.find((row) =>
      row.scope_type === 'project' && row.scope_id === project)
    if (projectOverride && projectOverride.mode !== 'inherit') {
      return { mode: projectOverride.mode, source: 'project' }
    }
  }
  return { mode: globalMode, source: 'global' }
}

export function writeApgAuditEvent(
  type: string,
  detail: Record<string, unknown>,
): void {
  try {
    appendFileSync(
      AUDIT_PATH,
      JSON.stringify({ type, detail, at: new Date().toISOString() }) + '\n',
    )
  } catch (err) {
    logger.warn({ err }, 'apg audit write failed')
  }
}
