// THE PRODUCTION CALLER, and the four things the owner asked it to prove.
//
// Owner's LIVE acceptance, 2026-09-04:
//
//   A) Neon cross-mailbox: production caller -> candidate row -> correct
//      personal target -> cross-mailbox provenance -> visible -> case_sources
//      unchanged.
//   B) CASE_PARENT: a known historical acceptance -> candidate row ->
//      canonical parent_case_id unchanged.
//   C) hard negative: a similar startup/cloud source -> no false Neon candidate.
//   D) namespace guard: 0 canonical namespace leakage.
//
// Every one of these goes through `ingestEmail`/`ingestZstEmail`, not through
// the scoring functions directly. That is the point: the layer was already
// proven to SCORE correctly by the replay scripts, and the readback still could
// not pass it, because nothing called it. A test that calls
// `sourceCaseCandidates` would have been green on the day the table held zero
// rows.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { ingestTriagedEmail } from '../cos/triage-bridge.js'
import { ingestTriagedZstEmail } from '../cos/zst-intake.js'
import { recordTriageReceipt } from '../cos/triage-provenance.js'
import { createCase } from '../cos/case-store.js'
import { MAX_TARGETS_PER_NAMESPACE } from '../cos/semantic/intake-candidates.js'

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0) / 1000

function candidates(): Array<Record<string, unknown>> {
  return getDb().prepare(
    `SELECT relation_type, namespace, source_ref, target_case_id, confidence,
            source_mailbox, target_mailbox, provenance, reasons_json
       FROM semantic_relation_candidates ORDER BY confidence DESC`,
  ).all() as Array<Record<string, unknown>>
}

function canonicalEdges(): number {
  return (getDb().prepare(`SELECT COUNT(*) c FROM case_sources`).get() as { c: number }).c
}

/** The dossier the Neon threads belong to: a personal case, named for a
 *  reference number that appears nowhere else. */
function seedNeonDossier(): void {
  createCase(getDb(), {
    caseId: 'CORP-CLOUD-2026-001',
    title: 'Neon Postgres szamlazas es kredit dosszie',
    caseType: 'ADMIN',
    status: 'NEW',
    description: 'Neon organisation ORG-NEON-77413 szamlazasi ugyei, 2026-08-01 es 2026-09-30 kozott. '
      + 'A havi szamlak es a kredit-egyenleg kovetese.',
    sensitivity: 'PERSONAL',
    priority: 'P2',
    sourceSystem: 'manual',
    sourceReference: 'seed',
    triageReceiptId: null,
  } as never, NOW - 30 * 86_400)
}

/** The cruel negatives: same topic, same fortnight, different vendor. */
function seedRivalCloudDossiers(): void {
  const rivals: Array<[string, string]> = [
    ['CORP-CLOUD-2026-002', 'Cloudflare startup kredit dosszie'],
    ['CORP-CLOUD-2026-003', 'Vercel startup kredit dosszie'],
    ['CORP-CLOUD-2026-004', 'Datadog startup kredit dosszie'],
  ]
  for (const [id, title] of rivals) {
    createCase(getDb(), {
      caseId: id, title, caseType: 'ADMIN', status: 'NEW',
      description: 'Startup kredit program, szamlazas es egyenleg kovetese, 2026-08-01 es 2026-09-30 kozott.',
      sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'manual',
      sourceReference: 'seed', triageReceiptId: null,
    } as never, NOW - 30 * 86_400)
  }
}

/** Every email-derived case needs a triage receipt whose id fingerprints the
 *  VERDICT (account, message, thread, manifest, actionable, caseType, title,
 *  workspace, priority, sensitivity, actor, model, prompt). So the receipt is
 *  derived from the very input being ingested -- a fixture that invented its own
 *  field values would hash to a different verdict and intake would refuse it,
 *  which is the gate doing its job.
 */
function withReceipt(input: Record<string, unknown>): Record<string, any> {
  const full: Record<string, any> = {
    sourceManifestHash: 'sha256:fixture',
    triageActor: 'test',
    triageModel: 'test-model',
    triagePromptFingerprint: 'rules:fixture',
    ...input,
  }
  recordTriageReceipt(getDb(), {
    accountId: full.accountId, messageId: full.messageId, threadId: full.threadId,
    sourceManifestHash: full.sourceManifestHash,
    actionable: full.actionable, caseType: full.caseType, title: full.title,
    workspace: full.workspace ?? null, priority: full.priority ?? null,
    declaredSensitivity: full.declaredSensitivity ?? null,
    actor: full.triageActor, model: full.triageModel,
    promptFingerprint: full.triagePromptFingerprint,
  } as never, NOW)
  return full
}

const zstIntake = (input: Record<string, unknown>, now: number) =>
  ingestTriagedZstEmail(getDb(), withReceipt(input) as never, now)

// THE BRIDGE, not `ingestEmail` directly: the bridge opens the per-email batch
// that intake's ledger requires, and it is what the HTTP route actually calls.
// Testing one layer below production would have meant building that batch by
// hand and proving a path no caller takes.
const personalIntake = (input: Record<string, unknown>, now: number) =>
  ingestTriagedEmail(getDb(), withReceipt(input) as never, now)

const zstMail = (over: Record<string, unknown> = {}) => ({
  accountId: 'zst',
  messageId: 'msg-neon-1',
  threadId: 'thr-neon-1',
  subject: 'Neon invoice for organisation ORG-NEON-77413',
  from: 'billing@neon.tech',
  snippet: 'Your Neon Postgres invoice for ORG-NEON-77413 is ready. Period 2026-08-01 to 2026-08-31.',
  actionable: true,
  caseType: 'INVOICE_INCOMING',
  title: 'Neon szamla ORG-NEON-77413',
  direction: 'INBOUND' as const,
  ...over,
})

describe('the semantic layer has a production caller', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('A) a ZST-mailbox Neon thread proposes the PERSONAL dossier, cross-mailbox', () => {
    seedNeonDossier()
    seedRivalCloudDossiers()
    const edgesBefore = canonicalEdges()

    const r = zstIntake(zstMail(), NOW)
    expect(r.outcome).toBe('CASE_CREATED')

    // THE CALLER RAN. Without this the rest could pass on an empty table.
    expect(r.semanticCandidates).toBeDefined()
    expect(r.semanticCandidates!.error).toBeUndefined()
    expect(r.semanticCandidates!.namespacesEvaluated).toContain('personal')

    const rows = candidates()
    const source = rows.filter((c) => c.relation_type === 'SOURCE_CASE_CANDIDATE'
      && c.namespace === 'personal')
    expect(source.length).toBeGreaterThan(0)

    // The RIGHT personal target, not merely a personal one.
    expect(source[0].target_case_id).toBe('CORP-CLOUD-2026-001')

    // Cross-mailbox provenance is legible on the row itself.
    expect(source[0].source_mailbox).toBe('zst')
    expect(String(source[0].provenance)).toContain('cos-intake:semantic-source')

    // AND THE CANONICAL GRAPH DID NOT MOVE toward the personal dossier.
    // `case_sources` grows on a zst intake (the thread and message join the ZST
    // case), so the assertion is about WHICH edges exist, not how many.
    const toDossier = getDb().prepare(
      `SELECT COUNT(*) c FROM case_sources WHERE case_id = 'CORP-CLOUD-2026-001'`,
    ).get() as { c: number }
    expect(toDossier.c).toBe(0)
    expect(canonicalEdges()).toBeGreaterThanOrEqual(edgesBefore)
  })

  it('B) a new standalone case gets a PARENT proposal, and no canonical parent', () => {
    // The parent question is asked in the case's OWN store, so the acceptance
    // shape is a personal message arriving beside a personal dossier.
    seedNeonDossier()
    const r = personalIntake({
      accountId: 'private',
      messageId: 'msg-neon-p1',
      threadId: 'thr-neon-p1',
      subject: 'Neon invoice ORG-NEON-77413 August',
      from: 'billing@neon.tech',
      snippet: 'Invoice for ORG-NEON-77413, period 2026-08-01 to 2026-08-31.',
      actionable: true,
      caseType: 'ADMIN',
      title: 'Neon szamla',
      direction: 'INBOUND',
    }, NOW)
    expect(r.outcome).toBe('CASE_CREATED')

    const parents = candidates().filter((c) => c.relation_type === 'CASE_PARENT_CANDIDATE')
    expect(parents.length).toBeGreaterThan(0)
    expect(parents[0].target_case_id).toBe('CORP-CLOUD-2026-001')

    // THE CANONICAL PARENT IS UNTOUCHED. This is the assertion that makes the
    // proposal safe rather than merely polite.
    const child = getDb().prepare(
      `SELECT parent_case_id FROM personal_cases WHERE case_id = ?`,
    ).get(r.caseId) as { parent_case_id: string | null }
    expect(child.parent_case_id).toBeNull()
  })

  it('C) a rival cloud vendor does NOT land on the Neon dossier', () => {
    seedNeonDossier()
    seedRivalCloudDossiers()

    const r = zstIntake(zstMail({
      messageId: 'msg-cf-1', threadId: 'thr-cf-1',
      subject: 'Cloudflare startup credit statement',
      from: 'billing@cloudflare.com',
      snippet: 'Your Cloudflare startup credit statement. Period 2026-08-01 to 2026-08-31.',
      title: 'Cloudflare kredit',
    }), NOW)
    expect(r.outcome).toBe('CASE_CREATED')

    const onNeon = candidates().filter((c) => c.target_case_id === 'CORP-CLOUD-2026-001')
    expect(onNeon).toEqual([])
  })

  it('C2) and the negative is not achieved by proposing nothing ever', () => {
    // The control that makes C mean something. A caller that always returned
    // zero rows would pass C perfectly.
    seedNeonDossier()
    seedRivalCloudDossiers()
    zstIntake(zstMail(), NOW)
    expect(candidates().filter((c) => c.target_case_id === 'CORP-CLOUD-2026-001').length)
      .toBeGreaterThan(0)
  })

  it('D) no canonical namespace leakage: proposals cross stores, edges never do', () => {
    seedNeonDossier()
    zstIntake(zstMail(), NOW)

    // A proposal in the personal namespace exists...
    expect(candidates().some((c) => c.namespace === 'personal')).toBe(true)

    // ...and every CANONICAL edge written by this intake names the zst case.
    const rows = getDb().prepare(
      `SELECT namespace, case_id FROM case_sources`,
    ).all() as Array<{ namespace: string; case_id: string }>
    for (const row of rows) {
      expect(row.namespace).toBe('zst')
      expect(row.case_id.startsWith('zst-')).toBe(true)
    }
    // And no personal case gained a source it did not have.
    const personalEdges = rows.filter((row) => row.namespace === 'personal')
    expect(personalEdges).toEqual([])
  })

  it('a PARENT proposal never crosses stores', () => {
    // A parent is a canonical relation inside one authority. Proposing one
    // across stores would be proposing the namespace migration this layer is
    // forbidden to perform -- and it is the SOURCE question, not the parent
    // question, that is allowed to cross mailboxes.
    seedNeonDossier()
    zstIntake(zstMail(), NOW)
    const parents = candidates().filter((c) => c.relation_type === 'CASE_PARENT_CANDIDATE')
    for (const p of parents) expect(p.namespace).toBe('zst')
    expect(parents.every((p) => String(p.target_case_id).startsWith('zst-'))).toBe(true)
  })

  it('a case is never proposed as its own parent', () => {
    seedNeonDossier()
    const r = personalIntake({
      accountId: 'private', messageId: 'msg-self', threadId: 'thr-self',
      subject: 'Neon invoice ORG-NEON-77413', from: 'billing@neon.tech',
      snippet: 'ORG-NEON-77413 period 2026-08-01 to 2026-08-31',
      actionable: true, caseType: 'ADMIN', title: 'Neon', direction: 'INBOUND',
    }, NOW)
    const selfParent = candidates().filter(
      (c) => c.relation_type === 'CASE_PARENT_CANDIDATE' && c.target_case_id === r.caseId,
    )
    expect(selfParent).toEqual([])
  })

  it('a candidate never becomes a parent by itself', () => {
    seedNeonDossier()
    const r = personalIntake({
      accountId: 'private', messageId: 'msg-p2', threadId: 'thr-p2',
      subject: 'Neon invoice ORG-NEON-77413', from: 'billing@neon.tech',
      snippet: 'ORG-NEON-77413 period 2026-08-01 to 2026-08-31',
      actionable: true, caseType: 'ADMIN', title: 'Neon', direction: 'INBOUND',
    }, NOW)
    const parents = getDb().prepare(
      `SELECT COUNT(*) c FROM personal_cases WHERE parent_case_id IS NOT NULL`,
    ).get() as { c: number }
    expect(parents.c).toBe(0)
    expect(r.caseId).toBeTruthy()
  })
})

describe('bounded and idempotent, which a per-message caller must be', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the same source twice does not grow the table', () => {
    seedNeonDossier()
    zstIntake(zstMail(), NOW)
    const first = candidates().length
    expect(first).toBeGreaterThan(0)

    // A second message on the SAME thread: same source ref, same engine, same
    // targets. Rows refresh in place; they do not accumulate.
    zstIntake(zstMail({ messageId: 'msg-neon-2' }), NOW + 60)
    expect(candidates().length).toBe(first)
  })

  it('the target set is capped, so one email cannot scan the whole store', () => {
    // BEHAVIOURAL, and the previous version of this test was not: it asserted
    // that the constant equalled itself, which a mutation deleting the LIMIT
    // sailed straight through. What matters is how many targets an arriving
    // email is actually scored against.
    for (let i = 0; i < MAX_TARGETS_PER_NAMESPACE + 25; i++) {
      createCase(getDb(), {
        caseId: `BULK-${String(i).padStart(4, '0')}`, title: `bulk case ${i}`,
        caseType: 'ADMIN', status: 'NEW', description: 'filler',
        sensitivity: 'PERSONAL', priority: 'P2', sourceSystem: 'manual',
        sourceReference: 'seed', triageReceiptId: null,
      } as never, NOW - 86_400)
    }
    const r = zstIntake(zstMail(), NOW)
    expect(r.semanticCandidates!.targetsConsidered).toBeLessThanOrEqual(
      MAX_TARGETS_PER_NAMESPACE * 2,
    )
    // The personal store alone exceeds the cap, so an uncapped scan would show it.
    const personalCount = (getDb().prepare(
      `SELECT COUNT(*) c FROM personal_cases WHERE archived_at IS NULL`,
    ).get() as { c: number }).c
    expect(personalCount).toBeGreaterThan(MAX_TARGETS_PER_NAMESPACE)
    expect(r.semanticCandidates!.targetsConsidered).toBeLessThan(personalCount)
  })

  it('a failure inside the layer never breaks the intake', () => {
    seedNeonDossier()
    // Remove the table the proposals go into. The email must still be filed.
    getDb().exec(`DROP TABLE semantic_relation_candidates`)
    const r = zstIntake(zstMail(), NOW)
    expect(r.outcome).toBe('CASE_CREATED')
    // ...and the failure is REPORTED, not swallowed into a clean-looking zero.
    expect(r.semanticCandidates?.error).toBeTruthy()
  })
})
