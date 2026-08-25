// LOCAL-FORK: cos seam (keep on rebase). Read-only Mission Control API for the
// Personal Chief of Staff (COS) case store. Serves the "Ma" (today) and
// "Ügyek" (all active) views from personal_cases. Read-only by design: this
// route never mutates a case — writes go through the domain-command layer
// (src/cos/case-store.ts), not the dashboard.
//
// Auth is centralized in src/web.ts (requiresAuth gates all /api/*), so every
// /api/cos/* path here is already Bearer-protected; no auth code needed.

import { randomUUID } from 'node:crypto'
import { json, readBody } from '../http-helpers.js'
import { getDb } from '../../db.js'
import { listActiveCases, listTodayCases } from '../../cos/case-store.js'
import { listActiveZstCases, listTodayZstCases } from '../../cos/zst-case-store.js'
import { dueZstItems } from '../../cos/zst-watch.js'
import { ingestTriagedEmail, type TriagedEmail } from '../../cos/triage-bridge.js'
import { ingestTriagedZstEmail, type ZstTriagedEmail } from '../../cos/zst-intake.js'
import {
  draftZstSend, approveZstSend, rejectZstSend, dispatchZstSend,
  renderedPayloadHash as zstPayloadHash,
} from '../../cos/zst-send.js'
import {
  createEscalation, getEscalation, listOpenEscalations, transitionEscalation, isHardGated,
} from '../../cos/zst-productlab.js'
import { validateSkillMd, validateSkillPermissions } from '../../cos/skill-permission-validator.js'
import { getMissionControlProgressionView, runProgressionCycle } from '../../cos/progression-pipeline.js'
import { semanticQualityMetrics, qualityConcerns, QUALITY_THRESHOLDS } from '../../cos/progression-quality.js'
import { tryClaimProgression, releaseProgressionClaim } from '../../cos/progression-scheduler.js'
import { storeDocument, documentsForCase, readDocumentBytes, resolveShareableAttachments } from '../../cos/cos-documents.js'
import { engageKillSwitch, releaseKillSwitch, killSwitchState } from '../../cos/kill-switch.js'
import { evaluateOutputFloors, breachedFloors } from '../../cos/output-floor.js'
import { runDailyReconcile } from '../../cos/reconcile.js'
import { listNeedsHuman, listDueForRetry } from '../../cos/recovery-queue.js'
import { operationalHealth } from '../../cos/operational-health.js'
import { linkCases, suggestLinks, linkedCases } from '../../cos/case-link.js'
import { classifyScope, describeScope } from '../../cos/scope-gate.js'
import { deriveAnswerOptions } from '../../cos/answer-options.js'
import { interpretOwnerAnswer, ballMoved } from '../../cos/answer-interpretation.js'
import { resolveInterpreter } from '../../cos/interpreter-provider.js'
import { getSecret } from '../vault.js'

/** The account the COS sends personal mail from. */
const COS_SEND_FROM = 'iszzu80@gmail.com'
import { rejectSend, approveSend, renderedPayloadHash, dispatchApprovedSend, type EmailDraft } from '../../cos/send-flow.js'
import { GmailSendAdapter } from '../../cos/adapters/gmail-send.js'
import { GmailApiTransport } from '../../cos/adapters/gmail-api-transport.js'
import { permits } from '../../cos/autonomy-ladder.js'
import { APP_TZ } from '../../config.js'
import type { RouteContext } from './types.js'

// End of "today" in the app timezone, as a Unix-seconds horizon. Computed from
// the wall clock in APP_TZ so a case due later today is included but tomorrow's
// is not. Falls back to now+24h if the timezone math is unavailable.
export function endOfTodaySec(now: Date): number {
  try {
    // Seconds elapsed into the current local day (APP_TZ), then seconds left
    // until local midnight. No offset arithmetic, no DST edge cases.
    const [h, m, s] = new Intl.DateTimeFormat('en-GB', {
      timeZone: APP_TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(now).split(':').map(Number)
    const secsIntoDay = h * 3600 + m * 60 + s
    return Math.floor(now.getTime() / 1000) + (86400 - secsIntoDay) - 1 // local 23:59:59
  } catch {
    return Math.floor(now.getTime() / 1000) + 86400
  }
}

// Deep-compare two JSON strings by parsing and re-serializing — normalizes
// whitespace / key ordering so drift in serialization doesn't look like a
// changed question.
/** Personal sensitivity vocabulary → ZST vocabulary. The two are different
 *  vocabularies (schema.ts CASE_SENSITIVITIES vs zst-sensitivity ZST_SENSITIVITIES),
 *  and the Scope Gate can route a message posted from the private mailbox into
 *  the ZST store — at which point the personal value reaching coerceZstSensitivity
 *  matched nothing and fail-closed to ZST_HIGHLY_SENSITIVE. Safe, but it meant
 *  EVERY gate-routed case landed premium-only, which is how a fail-closed default
 *  turns into a reason to stop using the store. An unmapped value still returns
 *  undefined, which fail-closes exactly as before; content can only escalate. */
const PERSONAL_TO_ZST_SENSITIVITY: Record<string, string> = {
  PUBLIC: 'PUBLIC',
  PERSONAL: 'ZST_INTERNAL',
  SENSITIVE_PERSONAL: 'ZST_PERSONAL_DATA',
  HIGHLY_SENSITIVE: 'ZST_HIGHLY_SENSITIVE',
}

/** Personal case types carry no meaning in the ZST store, and passing one
 *  through (an 'EMAIL' where §8.2 expects INVOICE_INCOMING / CONTRACT / …) does
 *  not just mislabel the case — it silently skips the extractor triggers, so a
 *  supplier invoice routed here never reaches the invoice extractor at all.
 *  Anything without a ZST equivalent is dropped so zst-intake applies its own
 *  documented default (GENERAL_OPERATION) instead of inheriting a foreign one. */
const PERSONAL_TO_ZST_CASE_TYPE: Record<string, string> = {
  INVOICE: 'INVOICE_INCOMING',
  CONTRACT: 'CONTRACT',
}

/** Explicit boundary mapping for a Scope-Gate-routed message. This used to be
 *  `input as unknown as ZstTriagedEmail` — a double cast, which is the compiler
 *  being told to stop checking precisely where two vocabularies meet. */
export function toZstTriagedEmail(input: TriagedEmail): ZstTriagedEmail {
  return {
    accountId: input.accountId,
    messageId: input.messageId,
    threadId: input.threadId,
    subject: input.subject,
    from: input.from,
    to: input.to,
    snippet: input.snippet,
    direction: input.direction,
    actionable: input.actionable,
    title: input.title,
    followUpAt: input.followUpAt,
    headers: input.headers,
    caseType: input.caseType ? PERSONAL_TO_ZST_CASE_TYPE[input.caseType] : undefined,
    // Stage 2G: provenance crosses the boundary unchanged. Mapping it would
    // change the verdict fingerprint, and the gate would then reject the very
    // receipt the caller wrote.
    sourceManifestHash: input.sourceManifestHash,
    triageActor: input.triageActor,
    triageModel: input.triageModel,
    triagePromptFingerprint: input.triagePromptFingerprint,
    triageDecidedAt: input.triageDecidedAt,
    declaredSensitivity: input.declaredSensitivity
      ? PERSONAL_TO_ZST_SENSITIVITY[input.declaredSensitivity]
      : undefined,
  }
}

function deepJsonEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b))
  } catch {
    return a === b
  }
}

export async function tryHandleCos(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // The email-triage → COS intake bridge. The triage heartbeat POSTs a real
  // candidate here (with its verdict) to open/update a case. Idempotent per
  // (account, message). This is the ONLY /api/cos/* write path — the mutation
  // is confined to the intake domain logic.
  // §22 kill switch (card 89b2ab52). GET reads it, POST engages or releases.
  // The CLI (scripts/cos-kill-switch.ts) does the same without needing this
  // server to be healthy — a stop that only exists here is missing whenever the
  // dashboard itself is the problem.
  if (path === '/api/cos/kill-switch' && method === 'GET') {
    const s = killSwitchState(getDb())
    const recent = getDb().prepare(
      `SELECT engaged, reason, actor, tickets_revoked, created_at FROM cos_kill_switch_events
       ORDER BY event_id DESC LIMIT 10`
    ).all()
    json(res, { ...s, recent })
    return true
  }
  if (path === '/api/cos/kill-switch' && method === 'POST') {
    // Malformed JSON is a caller error, not a server error. This parse used to
    // sit outside a try, so a truncated body reached the global handler in
    // web.ts and came back as a 500 — the one endpoint whose whole job is to be
    // reachable in a panic reported "the server is broken" instead of "your
    // request was". Every other POST on this router already parses this way.
    let body: { engaged?: boolean; reason?: string; actor?: string }
    try { body = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    const now = Math.floor(Date.now() / 1000)
    const actor = body.actor || 'dashboard'
    if (body.engaged === true) {
      if (!body.reason) { json(res, { error: 'reason required to engage' }, 400); return true }
      json(res, engageKillSwitch(getDb(), { reason: body.reason, actor }, now))
      return true
    }
    if (body.engaged === false) {
      json(res, releaseKillSwitch(getDb(), { actor, reason: body.reason }, now))
      return true
    }
    json(res, { error: 'engaged must be true or false' }, 400)
    return true
  }

  if (path === '/api/cos/intake' && method === 'POST') {
    let input: TriagedEmail
    try { input = JSON.parse((await readBody(req)).toString()) as TriagedEmail }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!input?.accountId || !input?.messageId || !input?.subject) {
      json(res, { error: 'accountId, messageId, subject required' }, 400); return true
    }
    // IN-2 / §8. A missing threadId is NOT a 400: refusing the post would drop a
    // real letter to protect a linking invariant, which is the worse trade (see
    // openBatch/resolveThreadId — the message degrades to its own thread and the
    // row records that the value was derived). What the boundary does owe the
    // caller is a straight answer that it degraded, so a feeder dropping the
    // field is visible in its own logs rather than only in the store.
    const threadIdDerived = !input.threadId
    // Scope Gate (§2). The mailbox used to decide the store on its own, which
    // is deterministic and cheap and put two ZST share-transfer cases into the
    // personal store on 2026-08-09 because Istvan wrote them from his private
    // address. Owner decision the same day: the gate is the truth, the mailbox
    // is a signal that helps. So the mailbox is a prior and content can override
    // it; where neither is decisive the verdict says so instead of guessing
    // confidently.
    const now = Math.floor(Date.now() / 1000)
    const scope = classifyScope({
      text: `${input.subject}\n${input.snippet ?? ''}`,
      accountId: input.accountId,
    })
    if (scope.target === null) {
      // SECURITY_BLOCKED or CORPORATE_EXCLUDED: nothing is written anywhere. The
      // caller gets the verdict and the reasons, so a refusal is diagnosable.
      json(res, { outcome: 'SCOPE_BLOCKED', scope: scope.verdict, reasons: scope.reasons })
      return true
    }
    const zstTarget = scope.target === 'zst'
    const routed = zstTarget
      ? ingestTriagedZstEmail(getDb(), toZstTriagedEmail(input), now)
      : ingestTriagedEmail(getDb(), input, now)
    // F-13: the gate's VERDICT goes in the scope column, and the reason for a
    // review goes in scope_review_reason.
    //
    // It used to write neither. The verdict was returned in the response and
    // dropped; the scope column kept its 'PERSONAL_CONFIRMED' default, so every
    // case ever filed claimed to be a confirmed personal case even when the gate
    // had said AMBIGUOUS — and §25's "the Scope Gate is technically proven"
    // could not be answered from the store at all. The uncertainty went into
    // blocked_reason, a column §6.1 reserves for why a case is BLOCKED, so it
    // both lied and overwrote whatever real blocking reason was there.
    const caseId = (routed as { caseId?: string }).caseId
    if (caseId) {
      try {
        getDb().prepare(
          `UPDATE ${zstTarget ? 'zst_cases' : 'personal_cases'}
           SET scope = @scope,
               scope_review_reason = @why,
               updated_at = @now
           WHERE case_id = @id`
        ).run({
          scope: scope.verdict,
          why: scope.needsReview ? `SCOPE REVIEW — ${describeScope(scope)}` : null,
          now, id: caseId,
        })
      } catch { /* a missing column must not lose the case that was just filed */ }
    }
    json(res, {
      ...routed, scope: scope.verdict, scopeReasons: scope.reasons, scopeNeedsReview: scope.needsReview,
      ...(threadIdDerived ? {
        threadIdDerived: true,
        threadIdNote: 'no threadId supplied — the message was filed as its own thread (§8). Pass candidate.threadId: a derived thread cannot link a later reply to this case.',
      } : {}),
    })
    return true
  }

  // Owner approval for a prepared send (§22 EXECUTE_WITH_APPROVAL).
  //
  // Until now the send flow had no door: the code existed and was tested, and
  // nothing could reach it. That is what the gate meant by "no production
  // caller" — and why the honest answer to "where do I click?" was "nowhere".
  //
  // The approval is bound to the payload hash the owner actually saw. If the
  // draft changes between display and click, the hash no longer matches and the
  // approval authorizes nothing: approving a message means approving THAT text.
  if (path === '/api/cos/outbound/approve' && method === 'POST') {
    let b: { ledgerId?: string; renderedPayloadHash?: string; approvedBy?: string }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.ledgerId) { json(res, { error: 'ledgerId required' }, 400); return true }
    const now = Math.floor(Date.now() / 1000)
    try {
      const r = approveOutbound(getDb(), b.ledgerId, b.renderedPayloadHash, b.approvedBy ?? 'istvan', now)
      if (!r.ok) { json(res, r, 409); return true }
      // The button says "Elküldöm". Recording the approval and stopping there
      // would make it a button that means something else — and on 2026-08-10 it
      // did: the click recorded consent and a human still had to run the send by
      // hand. A control must do what its label promises.
      const sent = await dispatchApproved(getDb(), b.ledgerId, now, ctx.identity ?? null)
      json(res, { ...r, ...sent })
    } catch (e) { json(res, { error: String((e as Error).message) }, 400) }
    return true
  }

  if (path === '/api/cos/outbound/reject' && method === 'POST') {
    let b: { ledgerId?: string; reason?: string }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.ledgerId) { json(res, { error: 'ledgerId required' }, 400); return true }
    try {
      const action = rejectSend(getDb(), b.ledgerId, b.reason ?? 'Istvan elvetette', Math.floor(Date.now() / 1000))
      json(res, { ok: true, status: action.status })
    } catch (e) { json(res, { error: String((e as Error).message) }, 400) }
    return true
  }

  // Case linking (2026-08-09). Until now there was NO way to connect two cases:
  // related_case_ids existed as a column and nothing could write it — not the
  // engine (it is not among transitionCase's patch keys) and not the API. So the
  // GLS pickup notice sat beside the eCipő claim it belonged to, with no means
  // of joining them short of editing the database by hand.
  if (path === '/api/cos/cases/link' && method === 'POST') {
    let b: { caseA?: string; caseB?: string; reason?: string; namespace?: string }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.caseA || !b.caseB) { json(res, { error: 'caseA and caseB required' }, 400); return true }
    const zst = b.namespace === 'zst'
    const now = Math.floor(Date.now() / 1000)
    try {
      const r = linkCases(getDb(), b.caseA, b.caseB, b.reason ?? 'kézi összekötés', now,
        zst ? 'zst_cases' : 'personal_cases', zst ? 'zst_case_events' : 'personal_case_events')
      json(res, r)
    } catch (e) {
      json(res, { error: String((e as Error).message) }, 400)
    }
    return true
  }

  // What would link to this text? Suggestions only — the caller decides.
  if (path === '/api/cos/cases/link-suggestions' && method === 'POST') {
    let b: { text?: string; excludeCaseId?: string; namespace?: string }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.text) { json(res, { error: 'text required' }, 400); return true }
    json(res, { suggestions: suggestLinks(getDb(), b.text, b.excludeCaseId,
      b.namespace === 'zst' ? 'zst_cases' : 'personal_cases') })
    return true
  }

  // Document inlet (P2): the single HTTP door into the unified document store, used
  // by the email-triage heartbeat (Python) and later the Telegram flow to hand a
  // downloaded attachment/image to storeDocument. Accepts base64 content + metadata;
  // the store content-addresses it locally and links it to the case. Read/store only
  // — never sends. Sensitivity-first: absent sensitivity stays UNKNOWN (not shareable).
  if (path === '/api/cos/documents' && method === 'POST') {
    let b: {
      namespace?: string; caseId?: string; source?: string; sourceRef?: string
      filename?: string; mimeType?: string; contentBase64?: string; sensitivity?: string
      docKind?: string; externalShareAllowed?: boolean
    }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (b.namespace !== 'personal' && b.namespace !== 'zst') {
      json(res, { error: "namespace must be 'personal' or 'zst'" }, 400); return true
    }
    if (!b.source || !b.contentBase64) {
      json(res, { error: 'source and contentBase64 required' }, 400); return true
    }
    let bytes: Buffer
    try { bytes = Buffer.from(b.contentBase64, 'base64') }
    catch { json(res, { error: 'contentBase64 not decodable' }, 400); return true }
    if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) {
      json(res, { error: 'content empty or over 25MB' }, 400); return true
    }
    try {
      const r = storeDocument(getDb(), {
        namespace: b.namespace, caseId: b.caseId ?? null, source: b.source as never,
        sourceRef: b.sourceRef, filename: b.filename, mimeType: b.mimeType, bytes,
        sensitivity: b.sensitivity, docKind: b.docKind, externalShareAllowed: b.externalShareAllowed,
      })
      json(res, r)
    } catch (e) {
      json(res, { error: String((e as Error).message) }, 400)
    }
    return true
  }

  // #5c: validate a skill's declared permissions before it is written/run. Accepts
  // either a raw SKILL.md (`{skillMd}`) or a parsed decl (`{permissions, sensitiveApproved}`).
  if (path === '/api/cos/skill-validate' && method === 'POST') {
    let input: { skillMd?: string; permissions?: string[]; sensitiveApproved?: boolean }
    try { input = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    const result = typeof input?.skillMd === 'string'
      ? validateSkillMd(input.skillMd)
      : validateSkillPermissions({ permissions: input?.permissions, sensitiveApproved: input?.sensitiveApproved })
    json(res, result)
    return true
  }

  if (path === '/api/cos/cases' && method === 'GET') {
    const cases = listActiveCases(getDb())
    json(res, { cases, count: cases.length })
    return true
  }

  if (path === '/api/cos/today' && method === 'GET') {
    const horizon = endOfTodaySec(new Date())
    const cases = listTodayCases(getDb(), horizon)
    json(res, { cases, count: cases.length, horizon })
    return true
  }

  // ZST Corporate Case Engine read views (Slice 0). Read-only, separate
  // namespace (zst_cases) — mirrors the personal cases/today endpoints. Writes
  // go through src/cos/zst-case-store.ts, never the dashboard.
  if (path === '/api/cos/zst-cases' && method === 'GET') {
    const cases = listActiveZstCases(getDb())
    json(res, { cases, count: cases.length })
    return true
  }

  if (path === '/api/cos/zst-today' && method === 'GET') {
    const horizon = endOfTodaySec(new Date())
    const cases = listTodayZstCases(getDb(), horizon)
    json(res, { cases, count: cases.length, horizon })
    return true
  }

  // ── The corporate outbound door (§7.3, AT-ZA, card f832abf3) ──────────────
  //
  // Until now every corporate endpoint was a GET. draftZstSend, approveZstSend,
  // rejectZstSend, evaluateZstSendGate and dispatchZstSend were complete,
  // unit-tested, and unreachable: no non-test file imported any of them, and
  // zst_outbound_ledger held zero rows. The audit called that "Slice 1
  // write-half DONE". The module was done; the capability did not exist,
  // because it had no door.
  //
  // Real company email leaves through here, so the gates stand BEFORE the door
  // rather than behind it. evaluateZstSendGate is fail-closed on four layers at
  // once (write-usable connector, ZST sensitivity vs target profile, an
  // APPROVED approval at the campaign's current version bound to this exact
  // template + rendered payload, and the recipient present in that approval's
  // allowed list). Nothing here weakens any of them; the door only supplies
  // what the gate needs to judge.
  //
  // Three endpoints, deliberately separate. Drafting writes a ledger row and
  // sends nothing. Approving is the owner's YES to THIS text and THESE
  // recipients. Only approve dispatches, and only through the gate.

  if (path === '/api/cos/zst-outbound/draft' && method === 'POST') {
    let b: {
      caseId?: string; templateId?: string; to?: string; subject?: string; body?: string
      campaignId?: string; inReplyTo?: string; references?: string
    }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.caseId || !b.to || !b.subject || !b.body) {
      json(res, { error: 'caseId, to, subject, body required' }, 400); return true
    }
    try {
      const r = draftZstSend(getDb(), {
        caseId: b.caseId,
        // A vallalati fogalmazo ajto a dashboardon: Istvan nyitja meg, kezzel.
        // A tulajdonos szemelyes cselekvéset egy ugy-szintu automatizalasi
        // jelzo nem vetozza meg -- ugyanaz a dontes, mint a szemelyes uton.
        origin: 'owner',
        templateId: b.templateId ?? 'zst-freeform-v1',
        // Threading is opt-in and explicit. The first real corporate send went
        // out without it and landed as a new conversation in the recipient's
        // mailbox, so the door now carries it -- but a caller that does not say
        // "this answers X" still gets a new thread, which is right for a first
        // approach.
        email: { to: b.to, subject: b.subject, body: b.body, inReplyTo: b.inReplyTo, references: b.references },
        campaignId: b.campaignId,
      }, Math.floor(Date.now() / 1000))
      json(res, r)
    } catch (e) { json(res, { error: String((e as Error).message) }, 400) }
    return true
  }

  if (path === '/api/cos/zst-outbound/approve' && method === 'POST') {
    let b: {
      ledgerId?: string; renderedPayloadHash?: string
      approvedBy?: string; allowedRecipients?: string[]
    }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.ledgerId) { json(res, { error: 'ledgerId required' }, 400); return true }
    try {
      json(res, await approveAndDispatchZst(
        getDb(), b.ledgerId, b.renderedPayloadHash, b.approvedBy ?? 'istvan',
        b.allowedRecipients, Math.floor(Date.now() / 1000), ctx.identity ?? null,
      ))
    } catch (e) { json(res, { error: String((e as Error).message) }, 400) }
    return true
  }

  if (path === '/api/cos/zst-outbound/reject' && method === 'POST') {
    let b: { ledgerId?: string; reason?: string }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.ledgerId) { json(res, { error: 'ledgerId required' }, 400); return true }
    try {
      const action = rejectZstSend(getDb(), b.ledgerId, b.reason ?? 'Istvan elvetette', Math.floor(Date.now() / 1000))
      json(res, { ok: true, status: action.status })
    } catch (e) { json(res, { error: String((e as Error).message) }, 400) }
    return true
  }

  // ── Product Lab ↔ ZST escalation bridge (§23, card f832abf3 sibling) ──────
  //
  // zst-productlab.ts is the state machine for items the Product Lab sends up
  // for a business decision and answers ZST sends back down. It was complete
  // and tested and nothing imported it, so no escalation could ever be raised:
  // zst_product_escalations has zero rows for the same reason zst_outbound_ledger
  // did.
  //
  // Only a projection crosses -- summary, decision needed, due date -- never the
  // backlog (§23.4). Raising is all these endpoints do; a hard-gated request
  // (cost, contract, licence, subcontractor) is marked as such and waits for
  // Istvan, and this door does not offer a way to auto-accept one.
  if (path === '/api/cos/zst-escalations' && method === 'GET') {
    json(res, { escalations: listOpenEscalations(getDb()) })
    return true
  }

  if (path === '/api/cos/zst-escalations' && method === 'POST') {
    let b: {
      escalationId?: string; sourceWorkspace?: 'PRODUCT_LAB' | 'ZST'
      targetWorkspace?: 'PRODUCT_LAB' | 'ZST'; requestType?: string; summary?: string
      zstCaseId?: string; productId?: string; requiredDecision?: string
      requiredOutput?: string; dueAt?: number
    }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.escalationId || !b.sourceWorkspace || !b.targetWorkspace || !b.requestType || !b.summary) {
      json(res, { error: 'escalationId, sourceWorkspace, targetWorkspace, requestType, summary required' }, 400)
      return true
    }
    try {
      const row = createEscalation(getDb(), {
        escalationId: b.escalationId, sourceWorkspace: b.sourceWorkspace,
        targetWorkspace: b.targetWorkspace, requestType: b.requestType, summary: b.summary,
        zstCaseId: b.zstCaseId, productId: b.productId, requiredDecision: b.requiredDecision,
        requiredOutput: b.requiredOutput, dueAt: b.dueAt,
      }, Math.floor(Date.now() / 1000))
      // The caller is told whether this one needs Istvan, so a Product Lab
      // agent cannot mistake "recorded" for "approved".
      json(res, { ...row, hardGated: isHardGated(row) })
    } catch (e) { json(res, { error: String((e as Error).message) }, 400) }
    return true
  }

  if (path === '/api/cos/zst-escalations/transition' && method === 'POST') {
    let b: { escalationId?: string; status?: string; actor?: string }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.escalationId || !b.status) { json(res, { error: 'escalationId, status required' }, 400); return true }
    // transitionEscalation's hard gate is "only actor === 'istvan' may ACCEPT a
    // commitment". Over HTTP the actor is whatever the body says, and anything
    // holding the dashboard token can write 'istvan' — so passing it through
    // would turn a hard gate into a spelling exercise. The same shape as the
    // inter-agent bus having no sender authentication.
    //
    // So this door does not offer that move at all: a hard-gated ACCEPT is
    // refused here regardless of who the caller claims to be, and Istvan
    // accepts it where he actually is. Everything else transitions normally.
    const esc = getEscalation(getDb(), b.escalationId)
    if (escalationNeedsIstvanInPerson(esc, b.status)) {
      json(res, {
        error: 'hard-gated escalation: elfogadni csak Istvan tud, és nem ezen a végponton keresztül',
        requestType: esc!.request_type, hardGated: true,
      }, 403)
      return true
    }
    try {
      json(res, transitionEscalation(
        getDb(), b.escalationId, b.status as never, b.actor ?? 'marveen', Math.floor(Date.now() / 1000)))
    } catch (e) { json(res, { error: String((e as Error).message) }, 400) }
    return true
  }

  // ZST proactive due-item runner (contracts/licenses/obligations/opportunities).
  if (path === '/api/cos/zst-due' && method === 'GET') {
    json(res, dueZstItems(getDb()))
    return true
  }

  // ZST business-surface counts (invoices, contracts, vendors, licenses, etc.).
  if (path === '/api/cos/zst-business' && method === 'GET') {
    const db = getDb()
    const c = (t: string) => scalar(db, `SELECT COUNT(*) n FROM ${t}`)
    json(res, {
      invoices: c('zst_invoices'), accounting_packages: c('zst_accounting_packages'),
      bank_transactions: c('zst_bank_transactions'), contracts: c('zst_contracts'),
      obligations: c('zst_obligations'), vendors: c('zst_vendors'), licenses: c('zst_licenses'),
      partners: c('zst_partners'), opportunities: c('zst_opportunities'), products: c('zst_products'),
      procurement_radar: c('zst_procurement_radar_items'), escalations: c('zst_product_escalations'),
      outbound: c('zst_outbound_ledger'),
    })
    return true
  }

  if (path === '/api/cos/outbound' && method === 'GET') {
    const outbound = listOutbound(getDb())
    json(res, { outbound, count: outbound.length })
    return true
  }

  if (path === '/api/cos/campaigns' && method === 'GET') {
    const campaigns = listCampaignsSummary(getDb())
    json(res, { campaigns, count: campaigns.length })
    return true
  }

  if (path === '/api/cos/radar' && method === 'GET') {
    const radar = listRadarSummary(getDb())
    json(res, { radar, count: radar.length })
    return true
  }

  if (path === '/api/cos/monitoring' && method === 'GET') {
    json(res, listMonitoring(getDb()))
    return true
  }

  if (path === '/api/cos/analytics' && method === 'GET') {
    json(res, listAnalytics(getDb()))
    return true
  }

  // Progression layer Mission Control view (card 52250c7f). Read-only — the
  // progression engine writes state; this endpoint only returns it for the UI.
  // Answer options for a question, derived from the question itself.
  // Istvan, 2026-08-09: "az igen/nem rádiógomb sem egyértelmű sokszor". The
  // cause was structural — the engine asked without supplying options, so the
  // surface had only the generic pair to show. Derived here, once, and rendered
  // as given: on an open question the honest answer is NO buttons.
  if (path === '/api/cos/answer-options' && method === 'POST') {
    let b: { question?: string; choices?: Array<{ value: string; label: string }> }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    json(res, deriveAnswerOptions(b.question ?? '', b.choices))
    return true
  }

  // Interpret the owner's typed answer — as a PROPOSAL, at the moment he answers.
  //
  // His framing: the model belongs here, not in the five-minute stepping loop.
  // The loop runs over dozens of cases unattended, and a misreading there writes
  // state at night with nobody watching. Here there is one call and he is
  // looking at the screen.
  //
  // This endpoint WRITES NOTHING. It returns what the model thinks follows; he
  // accepts or corrects it through the existing owner-action control.
  if (path === '/api/cos/interpret-answer' && method === 'POST') {
    let b: { caseId?: string; question?: string; answer?: string }
    try { b = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }
    if (!b.caseId || !b.answer) { json(res, { error: 'caseId and answer required' }, 400); return true }
    const c = getDb().prepare(
      `SELECT title, status, next_action_owner FROM personal_cases WHERE case_id = ?`
    ).get(b.caseId) as { title: string; status: string; next_action_owner: string | null } | undefined
    if (!c) { json(res, { ok: false, reason: `nincs ilyen ügy: ${b.caseId}` }, 404); return true }

    const ctx = {
      caseId: b.caseId, caseTitle: c.title, question: b.question ?? '',
      currentOwner: c.next_action_owner ?? undefined, currentStatus: c.status,
    }
    // THE SAME RESOLVER THE REST OF THE SYSTEM USES. This endpoint used to build
    // its own `new AnthropicLlmClient()` with no arguments, which stores
    // `apiKey: undefined` and falls back to the ENV alone — so it could not see
    // the vault, where Istvan's Anthropic key actually lives (e17e710). The
    // README even tells the installer NOT to set ANTHROPIC_API_KEY next to an
    // OAuth token, so in the recommended install the env is empty and this path
    // could never have worked. Review #5, Ö-3.
    const interp = resolveInterpreter(getSecret)
    if (!interp) {
      // "NOT CONFIGURED" AND "NOT ANSWERING" ARE DIFFERENT FACTS, and the old
      // single message made an endpoint that never worked indistinguishable from
      // an overloaded model. The surface still falls back to plain text entry;
      // it just no longer misreports why.
      json(res, {
        ok: false,
        reason: 'nincs konfigurált értelmező (nincs ANTHROPIC kulcs az env-ben és nincs DEEPSEEK_API_KEY a vaultban)',
        cause: 'not_configured',
      })
      return true
    }
    try {
      const r = await interpretOwnerAnswer(interp.client, ctx, b.answer)
      json(res, r.ok ? { ...r, ballMoved: ballMoved(ctx, r.proposal!) } : r)
    } catch (e) {
      // Configured, and it failed: an overloaded or erroring model. The owner
      // does not have to solve this either — but now it is legible as a
      // different problem from the one above.
      json(res, {
        ok: false,
        reason: `az értelmező (${interp.provider}/${interp.model}) nem válaszolt: ${(e as Error).message}`,
        cause: 'call_failed',
      })
    }
    return true
  }

  if (path === '/api/cos/progression' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const domain = (q.get('domain') || 'personal') as 'personal' | 'zst'
    if (domain !== 'personal' && domain !== 'zst') {
      json(res, { error: 'domain must be personal or zst' }, 400); return true
    }
    const view = getMissionControlProgressionView(getDb(), domain)
    json(res, view)
    return true
  }

  // §4.2 — the semantic-quality metrics.
  //
  // A SURFACE, NOT A LIBRARY. The live report that prompted §4.2 found 101 cases
  // sharing 11 distinct next-best-action sentences, and every dashboard at the
  // time said the fields were populated — because "is it filled?" was the only
  // question anything asked. Metrics computed by a function nobody calls would
  // answer that question exactly as badly, so they get a route on the same
  // surface the progression view already uses.
  //
  // `concerns` travels with the numbers on purpose: a reader who does not know
  // that 0.109 is catastrophic and 0.9 is fine learns nothing from the ratio
  // alone, and a number nobody can interpret is not a measurement.
  if (path === '/api/cos/progression/quality' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const raw = q.get('domain')
    if (raw && raw !== 'personal' && raw !== 'zst') {
      json(res, { error: 'domain must be personal or zst' }, 400); return true
    }
    const metrics = semanticQualityMetrics(getDb(), (raw ?? undefined) as 'personal' | 'zst' | undefined)
    json(res, { metrics, concerns: qualityConcerns(metrics), thresholds: QUALITY_THRESHOLDS })
    return true
  }

  // Owner action (card 9193eedd): the control writes an event, not state.
  // Inserts into *_case_events, then runs ONE progression cycle so the UI
  // gets instant feedback instead of a 5-minute wait. Idempotent per key.
  // POST /api/cos/cases/:domain/:caseId/owner-action
  if (method === 'POST' && path.startsWith('/api/cos/cases/') && path.endsWith('/owner-action')) {
    const inner = path.slice('/api/cos/cases/'.length, -'/owner-action'.length)
    const slash = inner.indexOf('/')
    if (slash < 0) { json(res, { error: 'invalid path' }, 400); return true }
    const domain = inner.slice(0, slash) as 'personal' | 'zst'
    const caseId = inner.slice(slash + 1)
    if (domain !== 'personal' && domain !== 'zst') {
      json(res, { error: 'domain must be personal or zst' }, 400); return true
    }
    if (!caseId) { json(res, { error: 'caseId required' }, 400); return true }

    let body: {
      eventType?: string; choice?: string; text?: string
      sourceReference?: string; caseVersion?: number; idempotencyKey?: string
      externalEffectAck?: boolean; decision?: string; nextBestAction?: string | null
    }
    try { body = JSON.parse((await readBody(req)).toString()) }
    catch { json(res, { error: 'invalid JSON' }, 400); return true }

    const {
      eventType, choice, text, sourceReference, caseVersion, idempotencyKey,
      externalEffectAck,
    } = body
    if (!eventType || !sourceReference || caseVersion == null || !idempotencyKey) {
      json(res, { error: 'eventType, sourceReference, caseVersion, idempotencyKey required' }, 400)
      return true
    }
    const validTypes = ['OWNER_DECISION', 'OWNER_INFORMATION', 'OWNER_CONFIRMATION']
    if (!validTypes.includes(eventType)) {
      json(res, { error: `eventType must be one of ${validTypes.join(', ')}` }, 400); return true
    }

    const db = getDb()
    const eventsTable = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
    const now = Math.floor(Date.now() / 1000)

    // Idempotency guard: same key → no second event, return first result.
    const existing = db.prepare(
      `SELECT event_id FROM ${eventsTable}
       WHERE case_id = ? AND json_extract(payload, '$.idempotency_key') = ?`
    ).get(caseId, idempotencyKey) as { event_id: number } | undefined
    if (existing) {
      json(res, { ok: true, eventId: existing.event_id, duplicate: true })
      return true
    }

    // Question-staleness guard (card 9193eedd follow-up #2):
    // Every heartbeat writes a new run row with a new progression_run_id, even
    // when the question hasn't changed — so comparing run IDs is the same bug
    // as comparing case_version, wearing a different field name.
    //
    // A question is identified by its CONTENT: the decision type plus what is
    // being asked (next_best_action_json). If both are unchanged, the answer
    // is current no matter how many heartbeats fired. 409 only when the case
    // genuinely moved on: a different decision, or a different step.
    // REQUEST_APPROVAL belongs here too. It was omitted, so a case sitting in
    // AWAITING_APPROVAL had no "active question" as far as this route was
    // concerned and every owner-action POST answered 404 — approvals were
    // answerable ONLY over Telegram. That left the strict surface unable to
    // answer and the loose one over-answering, which is the worst pairing.
    const QUESTION_DECISIONS = [
      'REQUEST_DECISION', 'REQUEST_APPROVAL', 'ASK_INFORMATION', 'RECOVERY_REQUIRED', 'WAIT_EXTERNAL',
    ]
    const latestQuestionRun = db.prepare(
      `SELECT r.progression_run_id, r.decision, s.next_best_action_json
       FROM case_progression_runs r
       LEFT JOIN case_progression_state s ON s.domain = r.domain AND s.case_id = r.case_id
       WHERE r.domain = ? AND r.case_id = ?
         AND r.decision IN (${QUESTION_DECISIONS.map(() => '?').join(',')})
       ORDER BY r.started_at DESC LIMIT 1`
    ).get(domain, caseId, ...QUESTION_DECISIONS) as {
      progression_run_id: string; decision: string; next_best_action_json: string | null
    } | undefined

    if (!latestQuestionRun) {
      json(res, { error: 'no active question for this case' }, 404); return true
    }

    // Content-based staleness: the frontend sends the decision + nextBestAction
    // it displayed. If both match the current state, the question is unchanged.
    const sameDecision = body.decision === latestQuestionRun.decision
    const sameNba = deepJsonEqual(body.nextBestAction ?? null, latestQuestionRun.next_best_action_json ?? null)
    if (!sameDecision || !sameNba) {
      json(res, {
        error: 'question_stale',
        currentSourceReference: latestQuestionRun.progression_run_id,
        currentDecision: latestQuestionRun.decision,
        currentNextBestAction: latestQuestionRun.next_best_action_json ?? null,
      }, 409)
      return true
    }

    // Build payload + reason.
    const payload = JSON.stringify({
      choice: choice ?? null,
      text: text ?? null,
      idempotency_key: idempotencyKey,
      external_effect_ack: externalEffectAck === true,
    })
    const reason = choice || text || eventType

    // Insert the event.
    const insertResult = db.prepare(
      `INSERT INTO ${eventsTable}
       (case_id, case_version, actor, source_system, source_reference,
        event_type, previous_status, new_status, reason, payload, correlation_id, created_at)
       VALUES (?, ?, 'istvan', 'mission_control', ?, ?, NULL, NULL, ?, ?, ?, ?)`
    ).run(caseId, caseVersion, sourceReference, eventType, reason, payload,
      `${caseId}:${sourceReference}`, now)

    // Run ONE progression cycle for instant feedback.
    let progressionResult: { newDecision: string | null; newNextBestAction: string | null }
    // The response used to hardcode progressionRan:true even when the cycle
    // threw — so a caller that saw "ran, no new decision" could not tell a
    // quiet cycle from a crashed one, which is the same class of blindness as
    // the cycle reporting itself clean while per-item steps failed (83717a6).
    let progressionRan = true
    let progressionError: string | null = null
    // A14: this route ran the cycle claim-free while the heartbeat runner does
    // the same work from a separate cron process. Both could cycle one case at
    // once — duplicate run rows, and the answer-consumption transition racing
    // itself (the loser throws on seenVersion, is swallowed here, but the run
    // and state writes it already made stand). The lease is the same one the
    // heartbeat takes, so the two processes now queue instead of colliding.
    const claimRunId = `owner-action-${randomUUID()}`
    const leased = tryClaimProgression(db, domain, caseId, claimRunId, 120, now, { requireDue: false })
    if (!leased) {
      // Someone else holds the case right now. The event is already committed,
      // so the scheduled cycle will pick it up — say so instead of pretending.
      json(res, {
        ok: true,
        eventId: Number(insertResult.lastInsertRowid),
        progressionRan: false,
        progressionError: 'az ügyön most fut egy másik ciklus — az esemény rögzült, a következő futás feldolgozza',
        newDecision: null,
        newNextBestAction: null,
      })
      return true
    }
    try {
      const pr = runProgressionCycle(db, domain, caseId, now, {
        triggerType: 'MANUAL',
        triggerReference: sourceReference,
      })
      // Read new state. The decision belongs to the RUN that just finished;
      // next_best_action_json belongs to case_progression_state. This query
      // used to ask the runs table for both, so it threw "no such column:
      // next_best_action_json" on EVERY owner action — inside the try, where
      // the catch read it as "the engine failed". With progressionRan hardcoded
      // true, the response then reported a successful cycle that returned no
      // decision, and the instant feedback the control exists for never worked.
      // Nothing surfaced it because both halves of the lie agreed.
      const newRun = db.prepare(
        `SELECT decision FROM case_progression_runs
         WHERE domain = ? AND case_id = ?
         ORDER BY started_at DESC, progression_run_id DESC LIMIT 1`
      ).get(domain, caseId) as { decision: string | null } | undefined
      const newNba = db.prepare(
        `SELECT next_best_action_json FROM case_progression_state
         WHERE domain = ? AND case_id = ?`
      ).get(domain, caseId) as { next_best_action_json: string | null } | undefined
      progressionResult = {
        newDecision: newRun?.decision ?? null,
        newNextBestAction: newNba?.next_best_action_json ?? null,
      }
    } catch (e) {
      // Engine failure doesn't roll back the event — the event is already
      // committed; the next scheduled cycle will process it.
      progressionResult = { newDecision: null, newNextBestAction: null }
      progressionRan = false
      progressionError = String((e as Error)?.message ?? e)
    } finally {
      releaseProgressionClaim(db, domain, caseId, claimRunId, now)
    }

    json(res, {
      ok: true,
      eventId: Number(insertResult.lastInsertRowid),
      progressionRan,
      ...(progressionError ? { progressionError } : {}),
      ...progressionResult,
    })
    return true
  }

  // Card 3d9d62b1: per-case events (timeline). Read-only — the events table is
  // append-only by trigger, so this can never mutate. Query param: case_id + namespace.
  if (path === '/api/cos/events' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const caseId = q.get('case_id')
    const ns = q.get('namespace') || 'personal'
    if (!caseId) { json(res, { error: 'case_id required' }, 400); return true }
    const table = ns === 'zst' ? 'zst_case_events' : 'personal_case_events'
    const events = getDb().prepare(
      `SELECT event_id, case_version, actor, event_type, previous_status, new_status,
              reason, payload, correlation_id, created_at
       FROM ${table} WHERE case_id = ? ORDER BY created_at DESC LIMIT 20`
    ).all(caseId)
    json(res, { events, count: events.length })
    return true
  }

  // Card 3d9d62b1: per-case documents (attached files). Read-only.
  // Query param: case_id + namespace.
  if (path === '/api/cos/documents' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const caseId = q.get('case_id')
    const ns = (q.get('namespace') || 'personal') as 'personal' | 'zst'
    if (!caseId) { json(res, { error: 'case_id required' }, 400); return true }
    if (ns !== 'personal' && ns !== 'zst') { json(res, { error: 'namespace must be personal or zst' }, 400); return true }
    const docs = documentsForCase(getDb(), ns, caseId)
    json(res, { documents: docs, count: docs.length })
    return true
  }

  // Card 3d9d62b1: download a stored document file by id. Read-only — serves
  // the raw bytes from the content-addressed store with the correct MIME type.
  // The document id is the only required param; the server resolves namespace +
  // stored_path from the DB row and integrity-checks the bytes.
  if (path === '/api/cos/document-file' && method === 'GET') {
    const q = new URLSearchParams(req.url?.split('?')[1] ?? '')
    const docId = q.get('doc_id')
    if (!docId) { json(res, { error: 'doc_id required' }, 400); return true }
    try {
      const buf = readDocumentBytes(getDb(), docId)
      const row = getDb().prepare(
        `SELECT filename, mime_type FROM cos_documents WHERE document_id = ?`
      ).get(docId) as { filename: string | null; mime_type: string | null } | undefined
      const mime = row?.mime_type || 'application/octet-stream'
      const fname = row?.filename || docId
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': 'inline; filename="' + encodeURIComponent(fname) + '"',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=3600',
      })
      res.end(buf)
    } catch (e) {
      json(res, { error: (e as Error).message }, 404)
    }
    return true
  }

  return false
}

/** GROUP BY helper → {value: count}. */
function countBy(db: ReturnType<typeof getDb>, sql: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of db.prepare(sql).all() as Array<{ k: string; n: number }>) out[r.k] = r.n
  return out
}
function scalar(db: ReturnType<typeof getDb>, sql: string): number {
  return (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0
}

/**
 * COS analytics roll-up (#5d): aggregate counts over cases, the price radar, and
 * campaigns/outbound. Read-only, cheap GROUP BYs — the "campaign/radar analytics"
 * the spec §F names, plus a case overview.
 */
export function listAnalytics(db: ReturnType<typeof getDb>): {
  cases: { total: number; byStatus: Record<string, number>; bySensitivity: Record<string, number> }
  radar: { total: number; byStatus: Record<string, number>; observations: number; hits: number; notifications: number }
  campaigns: { total: number; byStatus: Record<string, number> }
  outbound: { total: number; byStatus: Record<string, number> }
} {
  return {
    cases: {
      total: scalar(db, `SELECT COUNT(*) n FROM personal_cases WHERE archived_at IS NULL`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM personal_cases WHERE archived_at IS NULL GROUP BY status`),
      bySensitivity: countBy(db, `SELECT sensitivity k, COUNT(*) n FROM personal_cases WHERE archived_at IS NULL GROUP BY sensitivity`),
    },
    radar: {
      total: scalar(db, `SELECT COUNT(*) n FROM radar_items`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM radar_items GROUP BY status`),
      observations: scalar(db, `SELECT COUNT(*) n FROM radar_observations`),
      hits: scalar(db, `SELECT COUNT(*) n FROM radar_items WHERE status='HIT'`),
      notifications: scalar(db, `SELECT COUNT(*) n FROM radar_items WHERE last_notified_at IS NOT NULL`),
    },
    campaigns: {
      total: scalar(db, `SELECT COUNT(*) n FROM campaigns`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM campaigns GROUP BY status`),
    },
    outbound: {
      total: scalar(db, `SELECT COUNT(*) n FROM outbound_ledger`),
      byStatus: countBy(db, `SELECT status k, COUNT(*) n FROM outbound_ledger GROUP BY status`),
    },
  }
}

// Read-only summaries for the Mission Control views. Exported so they are unit-
// testable against a seeded DB (the route wrapper is not).

export function listOutbound(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    // A payload is jon: egy jovahagyo felulet, ami nem mutatja meg MIT hagysz
    // jova, nem jovahagyas, hanem egy gomb. A cimzett kulon mezoben is, mert azt
    // kell a leghamarabb eszrevenni, ha rossz.
    `SELECT l.ledger_id, l.case_id, l.action_type, l.sequence_number, l.status,
            l.external_ref, l.attempt, l.updated_at, l.payload, l.recipient,
            l.campaign_id, c.title AS case_title
     FROM outbound_ledger l LEFT JOIN personal_cases c ON c.case_id = l.case_id
     ORDER BY l.created_at DESC LIMIT 50`
  ).all()
}

export function listCampaignsSummary(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    `SELECT c.campaign_id, c.case_id, c.campaign_type, c.status, c.version, c.allows_free_text,
        (SELECT COUNT(*) FROM campaign_approvals a WHERE a.campaign_id=c.campaign_id AND a.status='APPROVED'
           AND a.campaign_version=c.version) AS approved_current
     FROM campaigns c ORDER BY c.updated_at DESC LIMIT 50`
  ).all()
}

export function listRadarSummary(db: ReturnType<typeof getDb>): unknown[] {
  return db.prepare(
    `SELECT r.radar_id, r.case_id, r.kind, r.label, r.target_price, r.currency, r.status,
        r.best_seen_price, r.next_check_at,
        (SELECT best_price FROM radar_observations o WHERE o.radar_id=r.radar_id ORDER BY o.observed_at DESC LIMIT 1) AS latest_price,
        (SELECT observed_at FROM radar_observations o WHERE o.radar_id=r.radar_id ORDER BY o.observed_at DESC LIMIT 1) AS latest_at
     FROM radar_items r ORDER BY r.updated_at DESC LIMIT 50`
  ).all()
}

/**
 * Operational monitoring for the Mission Control "Monitoring" view (#5b): the
 * connector-health matrix, an outbound-status roll-up with the rows that need a
 * HUMAN (RECOVERY_REQUIRED / FAILED_TERMINAL — the executor never auto-resolves
 * these), send-quota usage, and the OUTPUT FLOORS.
 *
 * The floors answer the question the rest of this function cannot: not "did
 * something go wrong?" but "did anything happen at all?". Every surface here
 * reports on work that exists; a pipeline producing nothing has no rows to
 * report, and so reads as calm. That is precisely how the 2026-08-09 failures
 * stayed invisible for three days. `breached` is surfaced separately so a zero
 * cannot be scrolled past.
 *
 * `alerts` is the SAME reconcile the daily job runs (§19 + §14). One source, two
 * surfaces: if the Mission Control view and the 07:00 report could disagree,
 * you would eventually trust the quieter one.
 */
export function listMonitoring(db: ReturnType<typeof getDb>): {
  connectors: unknown[]; outboundHealth: { byStatus: Record<string, number>; needsAttention: unknown[] }
  quotas: unknown[]; outputFloors: unknown[]; breached: unknown[]
  alerts: { findings: unknown[]; counts: Record<string, number>; clean: boolean }
  recovery: { needsHuman: unknown[]; pendingRetry: unknown[]; counts: Record<string, number> }
  health: { stale: unknown[]; unverified: unknown[]; clean: boolean; checkedAt: number }
} {
  const connectors = db.prepare(
    `SELECT connector_id, kind, mode, status, consecutive_failures, last_ok_at, last_error_at, last_error
     FROM connector_health ORDER BY connector_id`
  ).all()
  const statusRows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM outbound_ledger GROUP BY status`
  ).all() as Array<{ status: string; n: number }>
  const byStatus: Record<string, number> = {}
  for (const r of statusRows) byStatus[r.status] = r.n
  const needsAttention = db.prepare(
    `SELECT ledger_id, case_id, action_type, status, last_error, updated_at
     FROM outbound_ledger WHERE status IN ('RECOVERY_REQUIRED','FAILED_TERMINAL')
     ORDER BY updated_at DESC LIMIT 50`
  ).all()
  const quotas = db.prepare(
    `SELECT quota_key, used_count, max_count, window_sec, window_start FROM send_quotas ORDER BY quota_key`
  ).all()
  const outputFloors = evaluateOutputFloors(db)
  const rec = runDailyReconcile(db)
  // W12 / §6.7: the recovery queue, READ-ONLY here.
  //
  // This endpoint does not reconcile. Membership is re-derived by the cycle
  // step (scripts/cos-recovery-queue.ts) every ten minutes, and a GET that
  // silently rewrote the queue would make the UI its own source of truth: the
  // page would then always agree with itself, whether or not the step that is
  // supposed to maintain it ever ran. A queue that is stale because the cycle
  // stopped is a fact worth being able to see.
  const recoveryCounts: Record<string, number> = {}
  for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM cos_recovery_queue GROUP BY status`)
    .all() as Array<{ status: string; n: number }>) recoveryCounts[r.status] = r.n
  const needsHuman = listNeedsHuman(db, 50).map(r => ({
    queueId: r.queueId, surface: r.surface, ref: r.ref, caseId: r.caseId,
    pendingAction: r.pendingAction, lastKnownOutcome: r.lastKnownOutcome,
    retryClass: r.retryClass, attempts: r.attemptCount, maxAttempts: r.maxAttempts,
    escalateAfter: r.escalateAfterAttempts, escalatedAt: r.escalatedAt,
    escalationReason: r.escalationReason, lastError: r.lastError,
  }))
  const pendingRetry = listDueForRetry(db, Math.floor(Date.now() / 1000) + 86400 * 365, 50).map(r => ({
    queueId: r.queueId, surface: r.surface, ref: r.ref, caseId: r.caseId,
    pendingAction: r.pendingAction, retryClass: r.retryClass,
    attempts: r.attemptCount, maxAttempts: r.maxAttempts, nextAttemptAt: r.nextAttemptAt,
    lastError: r.lastError,
  }))
  // W14 / §8.6 — the two metrics that had nothing behind them until the run
  // ledger got a writer: something that should be running and stopped, and
  // something that acted and was never confirmed. They fail in opposite
  // directions, so a surface carrying only one of them can be green while the
  // other is the outage.
  const health = operationalHealth(db, Math.floor(Date.now() / 1000))
  return { connectors, outboundHealth: { byStatus, needsAttention }, quotas,
    outputFloors, breached: breachedFloors(outputFloors),
    alerts: { findings: rec.findings, counts: rec.counts, clean: rec.clean },
    recovery: { needsHuman, pendingRetry, counts: recoveryCounts },
    health }
}


/** Approve a prepared send. Everything that can refuse, refuses here rather than
 *  in the UI: a browser-side check is a convenience, never a guarantee. */
export function approveOutbound(
  db: ReturnType<typeof getDb>, ledgerId: string, seenPayloadHash: string | undefined,
  approvedBy: string, now: number,
): { ok: boolean; reason: string; caseType?: string } {
  const row = db.prepare(
    `SELECT l.ledger_id, l.status, l.payload, l.recipient, l.campaign_id, l.case_id,
            c.case_type, k.template_hash
     FROM outbound_ledger l
     LEFT JOIN personal_cases c ON c.case_id = l.case_id
     LEFT JOIN campaigns k ON k.campaign_id = l.campaign_id
     WHERE l.ledger_id = ?`
  ).get(ledgerId) as
    | { status: string; payload: string | null; recipient: string | null; campaign_id: string | null
        case_id: string | null; case_type: string | null; template_hash: string | null } | undefined
  if (!row) return { ok: false, reason: `nincs ilyen kimenő művelet: ${ledgerId}` }
  if (row.status !== 'PLANNED') {
    return { ok: false, reason: `ez a művelet már ${row.status} állapotban van, nem hagyható jóvá újra` }
  }
  let draft: EmailDraft
  try { draft = JSON.parse(row.payload ?? '{}') as EmailDraft }
  catch { return { ok: false, reason: 'a levél tartalma nem olvasható' } }
  if (!draft.to || !draft.subject) return { ok: false, reason: 'a piszkozatból hiányzik a címzett vagy a tárgy' }

  const hash = renderedPayloadHash(draft)
  if (seenPayloadHash && seenPayloadHash !== hash) {
    // The draft moved under the owner between display and click.
    return { ok: false, reason: 'a levél megváltozott, mióta megnyitottad — nézd meg újra' }
  }
  const rung = permits(db, row.case_type ?? 'UNKNOWN', 'SEND')
  if (!rung.allowed) return { ok: false, reason: `autonómia-fokozat: ${rung.reason}`, caseType: row.case_type ?? undefined }

  if (!row.campaign_id || !row.template_hash) {
    return { ok: false, reason: 'ehhez a küldéshez nincs kampány vagy sablon — jóváhagyás nélkül nem megy ki' }
  }
  approveSend(db, {
    campaignId: row.campaign_id, templateHash: row.template_hash, renderedPayloadHash: hash,
    approvedBy, recipient: draft.to,
    // A jovahagyo gomb a dashboardon: Istvan nyomja meg, nem gep.
    initiatedBy: 'human',
  }, now)
  return { ok: true, reason: 'jóváhagyva', caseType: row.case_type ?? undefined }
}


/** Send an approved row through the full gate and the real adapter.
 *
 *  embedBodyMarker is FALSE on purpose: the owner approved that text verbatim,
 *  and a technical marker injected into the body would send something other than
 *  what was on screen. The cost is an honest one — the row rests at
 *  APPLIED_UNVERIFIED (provider accepted, own marker not searchable), which the
 *  daily reconcile watches. Trading the owner's exact words for a tidier status
 *  would be the wrong way round. */
/** Would accepting this escalation over HTTP bypass the hard gate?
 *
 *  zst-productlab's rule is "only actor === 'istvan' may ACCEPT a commitment".
 *  That works when the actor is established by something other than the actor's
 *  own claim. Over HTTP it is not: the body says who the caller is, anything
 *  holding the dashboard token can write 'istvan', and the gate becomes a
 *  spelling exercise. Same shape as the inter-agent bus having no sender
 *  authentication -- the `from` field is self-declared there too.
 *
 *  So the door does not try to authenticate the claim; it removes the move. A
 *  hard-gated ACCEPT is refused here no matter who the caller says they are, and
 *  Istvan accepts it where he actually is. Everything else transitions normally.
 *
 *  Exported so it can be exercised directly: a guard that can only be reached by
 *  standing up an HTTP server is a guard whose failure mode nobody has seen. */
export function escalationNeedsIstvanInPerson(
  esc: { request_type?: unknown; target_workspace?: string; hard_gate?: boolean } | undefined,
  targetStatus: string | undefined,
): boolean {
  if (!esc || targetStatus !== 'ACCEPTED') return false
  return isHardGated(esc as Parameters<typeof isHardGated>[0])
}

/** The corporate approve-and-send, mirroring dispatchApproved() on the personal
 *  side. Card f832abf3.
 *
 *  Three things it does NOT take from the request body, on purpose:
 *
 *  The template hash comes from the campaign row, not the caller. The gate's
 *  whole job is to check that the approval matches the campaign; letting the
 *  caller supply both sides of that comparison would make it agree with itself.
 *
 *  The sensitivity comes from the CASE, not from a constant. The personal side
 *  can hardcode 'PERSONAL' because everything in that store is; a corporate case
 *  can be ZST_INTERNAL, ZST_LEGAL or stricter, and the effective tier is
 *  escalated further by the content itself.
 *
 *  Be precise about what that buys TODAY, because it is less than it looks.
 *  targetProfile is fixed at 'premium_reasoning', and PROFILE_ALLOWLIST permits
 *  premium_reasoning for every tier including UNKNOWN. So the profile layer of
 *  evaluateZstSendGate cannot refuse anything this door sends, whatever the
 *  case's sensitivity says. That layer constrains which MODEL may process
 *  content; an owner-approved verbatim email is not processed by a model, so it
 *  has nothing to bite on here. The layers that actually bind this door are the
 *  write-usable connector and the approval binding (exact payload hash, exact
 *  recipient, current campaign version).
 *
 *  The tier is passed and returned anyway, for two reasons: the recorded
 *  decision should say what class of content left the company, and if the
 *  allowlist is ever tightened the door starts refusing without anyone having
 *  to remember to wire it. Returning it is what makes it checkable at all --
 *  an input nobody can observe is an input nobody can verify.
 *
 *  OWNER DECISION 2026-08-10 (Istvan, card d7e5df01, closed): no second approval
 *  for highly sensitive corporate mail. One binding YES is enough. Do not
 *  reopen this as a "gap" -- the profile layer being inert here is known and
 *  accepted, not an oversight anyone still has to fix.
 *
 *  The recipient list defaults to exactly the addressee of the drafted mail. An
 *  approval authorises the people the owner saw; an empty or wider list would
 *  turn one YES into a standing permission.
 *
 *  And the payload hash is compared before anything is recorded: approving a
 *  message means approving THAT text. If the draft changed since it was shown,
 *  the approval refers to a message that no longer exists. */
export async function approveAndDispatchZst(
  db: ReturnType<typeof getDb>,
  ledgerId: string,
  seenPayloadHash: string | undefined,
  approvedBy: string,
  allowedRecipients: string[] | undefined,
  now: number,
  /** W10: WHO clicked send on the corporate side. Same rule as the personal
   *  path -- absent means the broker refuses. */
  identity: import('../../identity/execution-identity.js').ExecutionIdentity | null = null,
): Promise<{ sent: boolean; status?: string; externalRef?: string; reasons?: string[]; sensitivityTier?: string }> {
  const row = db.prepare(
    `SELECT l.payload AS payload, l.campaign_id AS campaign_id, l.case_id AS case_id,
            k.template_hash AS template_hash, c.sensitivity AS sensitivity
     FROM zst_outbound_ledger l
     LEFT JOIN zst_campaigns k ON k.campaign_id = l.campaign_id
     LEFT JOIN zst_cases     c ON c.case_id     = l.case_id
     WHERE l.ledger_id = ?`,
  ).get(ledgerId) as {
    payload: string | null; campaign_id: string | null; case_id: string | null
    template_hash: string | null; sensitivity: string | null
  } | undefined

  if (!row?.payload || !row.campaign_id || !row.template_hash) {
    return { sent: false, reasons: ['a küldéshez hiányzik a tartalom vagy a kampány'] }
  }

  const email = JSON.parse(row.payload) as EmailDraft
  const hash = zstPayloadHash(email)
  if (seenPayloadHash && seenPayloadHash !== hash) {
    return { sent: false, reasons: ['a jóváhagyott szöveg azóta megváltozott — a jóváhagyás nem erre a levélre vonatkozik'] }
  }

  // An approval authorises the people the owner SAW — and what he saw is the
  // draft. This used to record whatever list the caller supplied (requiring
  // only that it contain the draft's recipient), so the caller could WIDEN the
  // allowlist written onto the envelope, and every later authorizeSend in the
  // campaign would honour the widened list. The draft is the only recipient
  // fact the owner actually approved, so the envelope is derived from it; a
  // caller trying to add anyone else is refused rather than quietly obeyed.
  const recipients = [email.to]
  const widened = (allowedRecipients ?? []).filter(r => r !== email.to)
  if (widened.length) {
    return { sent: false, reasons: [`a kérés a jóváhagyott címzetti listát bővítené (${widened.join(', ')}) — csak a megjelenített címzett hagyható jóvá`] }
  }

  approveZstSend(db, { initiatedBy: 'human',
    campaignId: row.campaign_id, templateHash: row.template_hash,
    renderedPayloadHash: hash, approvedBy, allowedRecipients: recipients,
  }, now)

  // The corporate mailbox, not the private one. Sending company mail from
  // iszzu80@gmail.com would pass every gate in this file and still be wrong.
  const transport = new GmailApiTransport({
    credsPath: 'store/.google-zst-creds.json', embedBodyMarker: false,
  })
  const r = await dispatchZstSend(db, new GmailSendAdapter(transport, ids => resolveShareableAttachments(db, ids)), {
    ledgerId, campaignId: row.campaign_id, connectorId: 'gmail-zst',
    email, templateHash: row.template_hash, renderedPayloadHash: hash,
    declaredSensitivity: row.sensitivity ?? undefined,
    targetProfile: 'premium_reasoning',
    identity,
  }, now)

  return {
    sent: r.sent, status: r.action?.status, externalRef: r.action?.externalRef ?? undefined,
    reasons: dispatchReasons(r),
    sensitivityTier: r.decision.sensitivityTier,
  }
}

/** Why did this dispatch not send?
 *
 *  `reasons` used to be populated only when the GATE refused. But the gate can
 *  allow and the executor's admission step still refuse — claim held, campaign
 *  ceiling reached, quota exhausted, kill switch engaged, ticket unconsumable —
 *  and that refusal lands only in the row's last_error. The caller then saw a
 *  bare `sent:false` with nothing to explain it, which reads as "it silently
 *  didn't work". Both refusal layers are surfaced here. */
export function dispatchReasons(r: {
  sent: boolean
  decision: { allowed: boolean; reasons: string[] }
  /** E18: the dispatcher's own summary of the post-gate refusal. */
  lastError?: string | null
  action?: { lastError?: string | null }
}): string[] | undefined {
  if (!r.decision.allowed) return r.decision.reasons
  if (r.sent) return undefined
  const admissionRefusal = r.lastError ?? r.action?.lastError
  return admissionRefusal ? [admissionRefusal] : ['a küldés nem történt meg, ok nélkül — nézd meg a sor állapotát']
}

export async function dispatchApproved(
  db: ReturnType<typeof getDb>, ledgerId: string, now: number,
  // W10: WHO clicked "Elkuldom". Threaded from the request principal rather than
  // resolved here, because the answer already exists one layer up and a second
  // resolver would be a second answer to one question. Absent -> the broker
  // refuses the send, which is the intended direction of failure for the loudest
  // action this system can take.
  identity: import('../../identity/execution-identity.js').ExecutionIdentity | null = null,
): Promise<{ sent: boolean; status?: string; externalRef?: string; reasons?: string[]; sensitivityTier?: string }> {
  // F-6: the case's own sensitivity has to come along. It used to be hardcoded
  // PERSONAL below, which silently downgraded every HIGHLY_SENSITIVE case on the
  // only live personal send path — the thing §10 forbids by name. The ZST query
  // three functions up already joins its case table for exactly this column; the
  // asymmetry was the tell that this was an omission, not a decision.
  const row = db.prepare(
    `SELECT l.payload AS payload, l.campaign_id AS campaign_id, l.case_id AS case_id,
            k.template_hash AS template_hash, c.sensitivity AS sensitivity
     FROM outbound_ledger l
     LEFT JOIN campaigns      k ON k.campaign_id = l.campaign_id
     LEFT JOIN personal_cases c ON c.case_id     = l.case_id
     WHERE l.ledger_id = ?`
  ).get(ledgerId) as {
    payload: string | null; campaign_id: string | null; case_id: string | null
    template_hash: string | null; sensitivity: string | null
  } | undefined
  if (!row?.payload || !row.campaign_id || !row.template_hash) {
    return { sent: false, reasons: ['a küldéshez hiányzik a tartalom vagy a kampány'] }
  }
  const email = JSON.parse(row.payload) as EmailDraft
  const transport = new GmailApiTransport({ from: COS_SEND_FROM, embedBodyMarker: false })
  const r = await dispatchApprovedSend(db, new GmailSendAdapter(transport, ids => resolveShareableAttachments(db, ids)), {
    ledgerId, connectorId: 'gmail', campaignId: row.campaign_id,
    templateHash: row.template_hash, renderedPayloadHash: renderedPayloadHash(email),
    email,
    // No fallback to 'PERSONAL' here on purpose: an absent value must stay
    // absent so coerceSensitivity() can do its job and fail closed to
    // HIGHLY_SENSITIVE. Defaulting to PERSONAL would reintroduce the downgrade
    // through the back door.
    declaredSensitivity: row.sensitivity ?? undefined,
    targetProfile: 'premium_reasoning',
    identity,
  }, now)
  return {
    sent: r.sent, status: r.action?.status, externalRef: r.action?.externalRef ?? undefined,
    reasons: dispatchReasons(r),
    // Surfaced so the tier the gate actually decided on is observable from
    // outside — the ZST door already returns it. An unobservable tier is how a
    // hardcoded one survived this long.
    sensitivityTier: r.decision.sensitivityTier,
  }
}
