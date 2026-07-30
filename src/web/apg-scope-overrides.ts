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

const OVERRIDES_PATH = join(PROJECT_ROOT, 'store', 'apg-scope-overrides.json')
const AUDIT_PATH = join(PROJECT_ROOT, 'store', 'apg-ui-audit.jsonl')
const APG_MODES: readonly ApgMode[] = ['off', 'observe', 'assisted', 'enforced']
const STORED_MODES: ReadonlyArray<ApgScopeOverride['mode']> = ['inherit', ...APG_MODES]
const KANBAN_CARD_ID_PATTERN = /^[0-9a-f]{8}$/

export interface StoredScopeOverride extends ApgScopeOverride {}

interface ScopeOverrideFile {
  overrides: StoredScopeOverride[]
}

function isStoredScopeOverride(value: unknown): value is StoredScopeOverride {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    (row.scope_type === 'project' || row.scope_type === 'kanban_card')
    && typeof row.scope_id === 'string'
    && STORED_MODES.includes(row.mode as ApgScopeOverride['mode'])
    && typeof row.updated_at === 'string'
    && typeof row.updated_by === 'string'
    && typeof row.reason === 'string'
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

export function setScopeOverride(input: {
  scope_type: 'project' | 'kanban_card'
  scope_id: string
  mode: string
  updated_by: string
  reason: string
}): { ok: true; override: StoredScopeOverride } | { ok: false; error: string } {
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
  if (typeof input.updated_by !== 'string' || !input.updated_by.trim()) {
    return { ok: false, error: 'updated_by is required' }
  }

  const mode = input.mode as ApgScopeOverride['mode']
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const globalMode = readGlobalMode()
  const isEnforcedDowngrade = (
    globalMode === 'enforced'
    && mode !== 'inherit'
    && APG_MODES.indexOf(mode) < APG_MODES.indexOf(globalMode)
  )
  if (isEnforcedDowngrade && !reason) {
    return { ok: false, error: 'reason is required when downgrading from enforced mode' }
  }

  const override: StoredScopeOverride = {
    scope_type: input.scope_type,
    scope_id: scopeId,
    mode,
    updated_at: new Date().toISOString(),
    updated_by: input.updated_by.trim(),
    reason,
  }
  const file = readScopeOverrideFile()
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
  writeApgAuditEvent('scope_override_set', { ...override })
  return { ok: true, override }
}

export function deleteScopeOverride(
  scopeType: 'project' | 'kanban_card',
  scopeId: string,
  updatedBy: string,
  reason: string,
): { ok: true } | { ok: false; error: string } {
  if (scopeType !== 'project' && scopeType !== 'kanban_card') {
    return { ok: false, error: 'scope_type must be project or kanban_card' }
  }
  if (typeof scopeId !== 'string') return { ok: false, error: 'scope_id is required' }
  const normalizedScopeId = scopeId.trim()
  const scopeIdError = validateScopeId(scopeType, normalizedScopeId)
  if (scopeIdError) return { ok: false, error: scopeIdError }
  if (typeof updatedBy !== 'string' || !updatedBy.trim()) {
    return { ok: false, error: 'updated_by is required' }
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return { ok: false, error: 'reason is required' }
  }

  const file = readScopeOverrideFile()
  const existingIndex = file.overrides.findIndex((row) =>
    row.scope_type === scopeType && row.scope_id === normalizedScopeId)
  if (existingIndex < 0) return { ok: false, error: 'Scope override not found' }
  const [deleted] = file.overrides.splice(existingIndex, 1)

  try {
    atomicWriteFileSync(OVERRIDES_PATH, JSON.stringify(file, null, 2) + '\n')
  } catch {
    return { ok: false, error: 'Failed to delete scope override' }
  }
  writeApgAuditEvent('scope_override_deleted', {
    override: deleted,
    updated_by: updatedBy.trim(),
    reason: reason.trim(),
  })
  return { ok: true }
}

export function resolveEffectiveApgMode(
  project: string | null,
  kanbanCardId: string | null,
): { mode: ApgMode; source: ApgModeSource } {
  const globalMode = readGlobalMode()
  if (globalMode === 'off') return { mode: 'off', source: 'global' }

  const overrides = readScopeOverrideFile().overrides
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
