import { createHash } from 'node:crypto'
import type { CorrectionManifest, ProductionCaseSnapshot, ReconciliationAuthority, ReconciliationFinding, ReconciliationSeverity, ReplayCaseProjection } from './types.js'

const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20)
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function authority(field: string, p: ProductionCaseSnapshot): ReconciliationAuthority {
  if ((p.hasHumanAuthorityEvent || p.hasExternalReceipt) && (field === 'status' || field === 'closureReason')) return 'PRODUCTION_AUTHORITATIVE'
  if (['title','caseType','nextAction','nextActionOwner','waitingOn','dueAt','followUpAt','nextWakeAt'].includes(field)) return 'SOURCE_DERIVED'
  return 'CONFLICT_REVIEW'
}

function severity(field: string, a: ReconciliationAuthority): ReconciliationSeverity {
  if (a === 'PRODUCTION_AUTHORITATIVE') return 'P3'
  if (['domain','status','nextAction','nextActionOwner','waitingOn','dueAt','followUpAt','nextWakeAt'].includes(field)) return 'P1'
  return 'P2'
}

export function reconcileReplay(
  replayRunId: string,
  replayCases: readonly ReplayCaseProjection[],
  productionCases: readonly ProductionCaseSnapshot[],
  generatedAt = Math.floor(Date.now() / 1000),
): CorrectionManifest {
  const findings: ReconciliationFinding[] = []
  const rs = new Map<string, ReplayCaseProjection[]>()
  const ps = new Map<string, ProductionCaseSnapshot[]>()
  for (const r of replayCases) { const x = rs.get(r.threadId) ?? []; x.push(r); rs.set(r.threadId, x) }
  for (const p of productionCases) for (const t of p.threadIds) { const x = ps.get(t) ?? []; x.push(p); ps.set(t, x) }

  for (const threadId of new Set([...rs.keys(), ...ps.keys()])) {
    const rr = rs.get(threadId) ?? []
    const pp = ps.get(threadId) ?? []
    if (rr.length !== 1 || pp.length !== 1) {
      findings.push({
        findingId: `recon:${h(`${replayRunId}:${threadId}:map`)}`,
        domain: rr[0]?.domain ?? pp[0]?.domain ?? 'personal', threadId,
        productionCaseId: pp[0]?.caseId ?? null, replayCaseId: rr[0]?.replayCaseId ?? null,
        field: 'case_mapping', productionValue: pp.map(x => x.caseId), replayValue: rr.map(x => x.replayCaseId),
        authority: 'CONFLICT_REVIEW', severity: 'P1',
        reason: 'thread identity does not map one-to-one; no repair may be inferred', autoApplyAllowed: false,
      })
      continue
    }
    const r = rr[0]; const p = pp[0]
    const pairs: Array<[string, unknown, unknown]> = [
      ['domain', p.domain, r.domain], ['title', p.title, r.title], ['caseType', p.caseType, r.caseType],
      ['status', p.status, r.status], ['nextAction', p.nextAction, r.nextAction],
      ['nextActionOwner', p.nextActionOwner, r.nextActionOwner], ['waitingOn', p.waitingOn, r.waitingOn],
      ['dueAt', p.dueAt, r.dueAt], ['followUpAt', p.followUpAt, r.followUpAt], ['nextWakeAt', p.nextWakeAt, r.nextWakeAt],
    ]
    for (const [field, pv, rv] of pairs) {
      if (same(pv, rv)) continue
      const a: ReconciliationAuthority = field === 'domain' ? 'CONFLICT_REVIEW' : authority(field, p)
      findings.push({
        findingId: `recon:${h(`${replayRunId}:${p.caseId}:${r.replayCaseId}:${field}:${JSON.stringify(pv)}:${JSON.stringify(rv)}`)}`,
        domain: r.domain, threadId, productionCaseId: p.caseId, replayCaseId: r.replayCaseId,
        field, productionValue: pv, replayValue: rv, authority: a, severity: severity(field, a),
        reason: a === 'PRODUCTION_AUTHORITATIVE'
          ? 'human/receipt-backed current state remains authoritative'
          : a === 'SOURCE_DERIVED'
            ? 'source replay produced a different projection; explicit review is required'
            : 'source alone cannot resolve this difference safely',
        autoApplyAllowed: false,
      })
    }
  }

  const n = (s: ReconciliationSeverity) => findings.filter(f => f.severity === s).length
  return {
    generatedAt, replayRunId, autoApplyAllowed: false, findings,
    summary: { total: findings.length, p0: n('P0'), p1: n('P1'), p2: n('P2'), p3: n('P3'), unclassified: 0 },
  }
}

export function replayReadyForStability(m: CorrectionManifest): boolean {
  return m.summary.unclassified === 0 && m.summary.p0 === 0 && m.summary.p1 === 0
}
