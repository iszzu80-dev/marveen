import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  listKanbanCards, createKanbanCard, updateKanbanCard,
  deleteKanbanCard, moveKanbanCard, archiveKanbanCard, unarchiveKanbanCard,
  getKanbanComments, addKanbanComment, getKanbanCardEvents, listKanbanProjects,
  getKanbanCard, getChildCards, getDb,
  createAgentMessage, markKanbanCardDispatched,
  getKanbanSeqByIdPrefix,
  listLabels, getLabel, createLabel, updateLabel, deleteLabel,
  addLabelToCard, removeLabelFromCard, getLabelsForAllCards, getLabelsForCard,
  listArchivedKanbanCards,
  revertIdeaFromKanban,
  getHeartbeatKanbanSummary,
} from '../../db.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { OWNER_NAME, BOT_NAME, MAIN_AGENT_ID, STORE_DIR, WEB_HOST, WEB_PORT, KANBAN_LABEL_COLORS } from '../../config.js'
import { listAgentNames, readAgentDisplayName, readAgentRemoteHost } from '../agent-config.js'
import { resolveCurrentSessionId } from '../transcript-sources.js'
import { isAgentRunning } from '../agent-process.js'
import { resolveKanbanDispatchTarget } from '../../kanban-dispatch.js'
import { createDispatchSafe, recordProducerCompletedOutcomeForCard } from '../../costops/dispatch.js'
import { resolveDispatchIdentitySafe } from '../../costops/dispatch-identity.js'
import { recordPacketMetadataSafe } from '../../costops/packet-metadata.js'
import { deriveExecutionId } from '../../apg/execution-binding.js'
import { recordCompletionClaimSafe, resolveClaimAuthority } from '../../apg/completion-claim.js'
import { resolveApgPrincipal } from '../apg-principal.js'
import {
  buildContextPacket, derivePacketMetadata, renderContextPacket, validateContextPacket,
  truncateExcerpt, MAX_SECTION_CHARS, type ContextPacket,
} from '../../context-packet.js'
import { evaluateDispatchAdmissionSafe } from '../dispatch-admission.js'
import { evaluateArchiveGate } from '../apg-archive-gate.js'
import { recordSaturationEventSafe } from '../../costops/saturation-events.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import type { RouteContext } from './types.js'

// A headless agent cannot "drag" a card to done, so the dispatch hands it the
// exact curl commands to (1) post a short, human-readable result summary as a
// comment -- so the finished task's result lands on its OWN card, visible in the
// dashboard UI -- and (2) mark the card done. This is the lightweight
// alternative to spawning a separate per-session card for every agent run: the
// result goes where the work was asked for, with zero extra board clutter. The
// token is read from the store at call time (never embedded in the message).
export function kanbanMoveInstructions(id: string, target: string): string {
  const tokenPath = join(STORE_DIR, '.dashboard-token')
  const base = `http://${WEB_HOST}:${WEB_PORT}`
  const auth = `-H "Authorization: Bearer $(cat ${tokenPath})"`
  const moveUrl = `${base}/api/kanban/${id}/move`
  const commentUrl = `${base}/api/kanban/${id}/comments`
  const cardUrl = `${base}/api/kanban/${id}`
  // Escalation target when blocked: sub-agents hand back to the main agent
  // (their delegator), who triages and only escalates to the operator when
  // the block genuinely needs a human decision. Only the main agent itself
  // escalates directly to OWNER_NAME -- sub-agent completions/blocks route
  // through the main agent, not straight to the operator (operator feedback,
  // 2026-07-02: a finished/blocked delegated card goes back to the delegator,
  // not to the human).
  const isMainAgent = target === MAIN_AGENT_ID
  const escalateTo = isMainAgent ? OWNER_NAME : MAIN_AGENT_ID
  return [
    'A kártyát in_progress-re húzták. Amikor VÉGEZTÉL, két lépés (mindkettő a kártyára kerül, a web UI-ban látszik):',
    '',
    '1) Írj egy rövid eredmény-összefoglalót kommentként (1-2 mondat: mi lett a vége):',
    `  curl -s -X POST ${commentUrl} \\`,
    `    ${auth} \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"author":"${target}","content":"AZ EREDMENY ROVIDEN"}'`,
    '',
    '2) Állítsd a kártyát done-ra:',
    `  curl -s -X POST ${moveUrl} \\`,
    `    ${auth} \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"status":"done"}'`,
    '',
    `Ha elakadtál / ${escalateTo} döntésére/lépésére vársz: NE csak status="waiting"-et állíts be. HÁROM lépés kell EGYÜTT:`,
    `  a) Írj egy kommentet ami KÖZVETLENÜL ${escalateTo}-hez szól, egyértelműen megfogalmazva mit kell eldöntenie/megtennie (NE a saját belső elemzésedet írd oda) -- ugyanaz a comments hívás mint fent, "content" mezőben.`,
    `  b) Told át a kártyát ${escalateTo}-re, hogy egyértelmű legyen a felelősség (a te neved NE maradjon rajta, ha nem te vagy a blokkoló):`,
    `     curl -s -X PUT ${cardUrl} \\`,
    `       ${auth} \\`,
    `       -H 'Content-Type: application/json' \\`,
    `       -d '{"assignee":"${escalateTo}"}'`,
    `  c) Csak EZUTÁN állítsd a kártyát status="waiting"-re (a fenti move-hívással, "waiting" értékkel "done" helyett).`,
    isMainAgent
      ? `Ez azért kritikus, mert ${OWNER_NAME} nem tudja kitalálni a dashboardon hogy egy nála maradt/rossz-assignee-jű, homályos kártya rá vár -- explicit átadás + explicit kérdés nélkül a felelősség-váltás elvész.`
      : `FONTOS: ${OWNER_NAME}-hez (az operátorhoz) EGYENESEN NE told át a kártyát, még ha a blokk végül tőle igényel is döntést -- ${MAIN_AGENT_ID} a delegálód, ő triázsol és ő dönti el, hogy tovább kell-e ${OWNER_NAME}-hez eszkalálnia. Ez azért kritikus, mert ${MAIN_AGENT_ID} nem tudja kitalálni a dashboardon hogy egy nála maradt/rossz-assignee-jű kártya rá vár -- explicit átadás + explicit kérdés nélkül a felelősség-váltás elvész.`,
    'A "done"-t mindenképp te jelezd — a dashboard csak az in_progress/waiting állapotot követi automatikusan a session aktivitásából. Az eredmény-kommentet (1) ne hagyd ki: az a kártyán a látható eredmény.',
  ].join('\n')
}

/** Headroom left below MAX_SECTION_CHARS for the title, the separator and the
 *  truncation notice, so a long description can never push the Goal section
 *  over the format limit and refuse its own dispatch. */
const GOAL_DESCRIPTION_HEADROOM = 400

/**
 * APG 1.9 §12.1: the PRODUCER context packet for one kanban card.
 *
 * WHAT IT CARRIES, and where each field comes from -- all of it decided
 * server-side from the card, never from anything an agent said:
 *
 *   execution_role      'producer' (§12.1-e). Same value the dispatch row
 *                       already stamps under §11.2, from the same origin
 *                       knowledge, so packet and row cannot disagree.
 *   objective           the card title + its description.
 *   constraints         priority / project / labels: the standing facts the
 *                       agent would otherwise have to go and look up.
 *   acceptance_criteria the done/result-comment protocol, unchanged.
 *
 * THE DESCRIPTION IS TRUNCATED, NOT REFUSED. A card description longer than
 * the format's section limit is, strictly, a pasted document -- but refusing
 * to dispatch such a card would be a regression against work that dispatches
 * fine today. So the head of it rides in the Goal, marked as cut by
 * truncateExcerpt(), and a constraint bullet points at the card as the
 * canonical full text. That is the packet's own discipline applied honestly:
 * large material by reference, with the reference being the card it came from.
 */
export function buildKanbanProducerPacket(
  card: { title: string; description?: string | null; priority?: string | null; project?: string | null },
  cardId: string,
  labels: string[],
  taskSize: 'small' | 'normal' | 'large' | null,
): ContextPacket {
  const desc = (card.description ?? '').trim()
  const descLimit = MAX_SECTION_CHARS - GOAL_DESCRIPTION_HEADROOM
  const shown = desc.length > descLimit ? truncateExcerpt(desc, descLimit) : desc
  const constraints = [
    ...(card.priority ? [`Prioritás: ${card.priority}`] : []),
    ...(card.project ? [`Projekt: ${card.project}`] : []),
    ...(labels.length ? [`Címkék: ${labels.join(', ')}`] : []),
    ...(shown.length < desc.length
      ? [`A kártya leírása itt le van vágva (${desc.length} karakter, formátum-limit ${descLimit}). ` +
         `A teljes szöveg a #${cardId} kártyán van -- olvasd onnan, ne találgass a levágott részről.`]
      : []),
  ]
  return buildContextPacket({
    executionRole: 'producer',
    cardId,
    goal: `[Kanban feladat #${cardId}]: ${card.title}${shown ? ' — ' + shown : ''}`,
    constraints,
    taskSize,
    dataSensitivity: 'internal',
    doneWhen: [`Card #${cardId} moved to done with a result comment`],
  })
}

// Option D: kanban -> agent dispatch. When a card moves to in_progress, wake the
// assigned agent once via the inter-agent message router (createAgentMessage),
// which gives retry / dedup / trust-wrapping / busy-receiver handling for free.
// dispatched_at is the once-only guard; errors never block the card move.
function fireKanbanDispatch(id: string): void {
  try {
    const card = getKanbanCard(id)
    if (!card || card.dispatched_at) return
    const target = resolveKanbanDispatchTarget(card.assignee, {
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      mainAgentId: MAIN_AGENT_ID,
      agentNames: listAgentNames(),
      isRunning: isAgentRunning,
    })
    if (!target) return
    // P2-A: mint the dispatch_id here (the kanban origin) with the card's known
    // metadata, then carry it on the queued message so the router threads it to
    // the funnel. Best-effort: a measurement failure never blocks the dispatch.
    // session_id is resolved from the target's newest local transcript so
    // correlateTokenUsageToDispatches() can actually place this dispatch in the
    // session timeline; a REMOTE agent's transcripts are on that host, so we
    // leave it NULL rather than resolve a stale local dir.
    // P2-B admission gate: refuse a LARGE work package into a session that is
    // already too saturated to hold it. taskSize comes from the card's LABELS via
    // the deployment-local workflow policy (session-efficiency.json) -- never
    // from a model, and never guessed: with the shipped defaults (empty label
    // table, agentDefault 'normal') nothing is ever refused, so this is inert
    // until an operator configures a size label. The gate fails OPEN on any
    // fault, so a broken config can never stop a dispatch.
    const cardLabels = getLabelsForCard(id).map(l => l.name)
    const admission = evaluateDispatchAdmissionSafe({ agent: target, labels: cardLabels })
    // P2-C: record the gate's own MEASURED observation, for both outcomes. Before
    // this, a refusal left no trace in the measurement stack at all (no dispatch
    // row is created for refused work), so `context_saturation_events` had no data
    // source and the one event that stops work was invisible to every read path.
    // Only measured observations are stored -- a fail-open default is not an
    // observation. Best-effort: never blocks the dispatch.
    recordSaturationEventSafe(getDb(), {
      agent: target,
      cardId: id,
      state: admission.state,
      pct: admission.pct,
      taskSize: admission.taskSize,
      admitted: admission.admit,
      refusalCode: admission.refusalCode ?? null,
      measured: admission.measured,
    })
    if (!admission.admit) {
      // Deliberately do NOT markKanbanCardDispatched: the work is deferred, not
      // dropped, so the next move into in_progress re-fires it once the target
      // has room. A refusal is never silent -- it lands as a card comment,
      // because a refusal only the log sees is a lost task.
      logger.warn({ id, target, state: admission.state, pct: admission.pct, taskSize: admission.taskSize },
        'Kanban dispatch refused by P2-B admission gate (large task into saturated session)')
      try {
        addKanbanComment(id, MAIN_AGENT_ID,
          `[CONTEXT-GUARD/P2-B] Dispatch to ${target} deferred: ${admission.reason}. ` +
          `taskSize=${admission.taskSize} (${admission.taskSizeSource}). ` +
          `The card stays undispatched -- move it to in_progress again once ${target} has context room, ` +
          `or checkpoint/restart ${target} first.`)
      } catch (err) {
        logger.warn({ err, id }, 'Kanban dispatch refusal comment failed')
      }
      return
    }
    // APG 1.9 §12.1 (WP4): the packet is BUILT, VALIDATED and then actually
    // SENT. Until now this origin built a packet, kept `derivePacketMetadata()`
    // and threw the rendered body away -- the agent received a hand-assembled
    // string instead, which is the 1.8 audit's WP4 finding in one line ("a
    // packet valódi, de a törzse sosem jut el az ügynökhöz"). The packet is
    // built BEFORE the dispatch row is minted, because a packet that fails
    // validation must not leave a dispatch id behind for a send that never
    // happened.
    const packet = buildKanbanProducerPacket(card, id, cardLabels, admission.taskSize)
    // validateContextPacket() had no production caller at all before this. It
    // is the format's own fail-closed edge: a packet carrying a credential
    // shape, an inlined document or a missing required section is not sent.
    const validation = validateContextPacket(packet)
    if (!validation.ok) {
      // Same shape as the admission refusal above: NOT dispatched, NOT marked
      // dispatched (so a fixed card re-fires on the next move), and never
      // silent. The message names the codes, never the offending text -- a
      // refusal that echoed a suspected credential into a card comment would
      // be the leak it just prevented.
      const codes = validation.errors.map(e => `${e.code}@${e.at}`).join(', ')
      logger.warn({ id, target, codes }, 'Kanban dispatch refused: context packet failed validation (§12.1)')
      try {
        addKanbanComment(id, MAIN_AGENT_ID,
          `[CONTEXT-PACKET/§12.1] Dispatch to ${target} refused: the context packet is not valid (${codes}). ` +
          `The card stays undispatched -- fix the card (usually: a document pasted into the description ` +
          `instead of referenced by path, or something credential-shaped in it) and move it to in_progress again.`)
      } catch (err) {
        logger.warn({ err, id }, 'Kanban packet-refusal comment failed')
      }
      return
    }
    // P2-C: stamp the identity columns (model_profile / configured_model /
    // runtime_model / provider / auth_profile / billing_mode). P2-A created them
    // but no origin populated them, so cost_per_accepted_task could only group by
    // agent. Best-effort by construction (resolveDispatchIdentitySafe): a
    // resolver fault stamps un-attributed instead of blocking the dispatch.
    // §11.2 role: the agent a card is dispatched TO is the one that authors the
    // work package, so its execution role is `producer`. The value is decided
    // here, from resolveKanbanDispatchTarget's output -- the agent never names
    // its own role, which is the whole point of §11.1. §12.1-e stamps the SAME
    // word on the packet above, from the same origin knowledge, so the two can
    // never disagree about what this execution was dispatched as.
    //
    // APG 1.9 §15.3-d / §28.17 (WP6): the dispatch is BOUND to a runner
    // execution identity, not merely measured. The id is DERIVED here, from
    // this dispatch's own seven facts, using the same content digest the
    // kernel's `execution_identity.execution_id_for` uses -- so the kernel can
    // mint the identical identity later and REFUSE a value that disagrees. See
    // src/apg/execution-binding.ts for why the derivation lives on both sides.
    //
    // Three things have to line up for the two derivations to agree, and all
    // three are pinned here rather than left to coincidence:
    //   * `dispatchedAtSec` is computed ONCE and both stamped on the row (via
    //     createDispatchSafe's `now`) and hashed into the id. Reading the clock
    //     twice would produce an id for a dispatch that does not exist.
    //   * `sessionId` is the SAME expression the row stores, evaluated once.
    //   * the packet metadata is derived BEFORE the dispatch row, because its
    //     hash is one of the seven facts. It used to be derived after.
    const dispatchedAtMs = Date.now()
    const dispatchedAtSec = Math.floor(dispatchedAtMs / 1000)
    const sessionId = readAgentRemoteHost(target) ? null : resolveCurrentSessionId(target)
    const packetMetadata = derivePacketMetadata(packet, new Date(dispatchedAtMs).toISOString())
    const executionId = deriveExecutionId({
      workItemId: id,
      agentId: target,
      role: 'producer',
      createdAt: dispatchedAtSec,
      sessionId,
      // WP7 owns the immutable delivery target; until it exists the kernel's
      // reserved TARGET_REF_UNKNOWN is hashed, which is what the kernel does too.
      targetRef: null,
      contextPacketHash: packetMetadata.packetHash,
    })
    const dispatchId = createDispatchSafe(getDb(), {
      source: 'kanban', role: 'producer', agent: target, cardId: id, project: card.project ?? null,
      sessionId,
      executionId,
      ...resolveDispatchIdentitySafe(target),
    }, dispatchedAtMs)
    // P2-B: record the packet metadata for this dispatch. Paths/hashes/sizes
    // only -- the packet BODY is never persisted. Best-effort by construction
    // (recordPacketMetadataSafe), so a metadata failure never blocks the send.
    // §12.1 (WP4): the record now also carries the packet IDENTITY -- packet_id,
    // packet_hash, generated_at, execution_role. That hash is the source the
    // kernel's execution identity has been storing CONTEXT_PACKET_HASH_UNKNOWN
    // for; `generatedAt` is stamped here, at the origin, because this module
    // may read a clock and context-packet.ts may not.
    recordPacketMetadataSafe(getDb(), dispatchId, {
      ...packetMetadata,
      taskSizeSource: admission.taskSizeSource,
    })
    // WHAT THE AGENT NOW RECEIVES: the rendered packet, followed by the
    // unchanged done/escalation protocol. The protocol is appended rather than
    // folded into a packet section on purpose -- it is 2116 characters of
    // transport instructions, over the format's MAX_SECTION_CHARS, and that
    // limit is exactly the rule that says "this is not context". Everything
    // the old hand-built string carried is still here: the card id and title
    // are the packet's header and Goal, the description follows them, and the
    // curl block is byte-identical.
    const content = `${renderContextPacket(packet)}\n${kanbanMoveInstructions(id, target)}`
    createAgentMessage(MAIN_AGENT_ID, target, content, null, null, dispatchId)
    markKanbanCardDispatched(id)
    logger.info({ id, target, assignee: card.assignee }, 'Kanban in_progress dispatch fired')
  } catch (err) {
    logger.warn({ err, id }, 'Kanban dispatch failed (card move still succeeded)')
  }
}

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    // Embed each card's labels in one extra JOIN query (getLabelsForAllCards)
    // instead of an N+1 per-card lookup, so the footer-pill UI gets
    // everything it needs in a single round trip.
    const labelsByCard = getLabelsForAllCards()
    const cards = listKanbanCards().map((card) => ({ ...card, labels: labelsByCard.get(card.id) ?? [] }))
    jsonMaybeGzip(req, res, cards)
    return true
  }

  // The heartbeat agent's kanban source. It exists so the agent does not have to
  // COMPOSE the filter every hour: on 2026-08-04 the 09:00 report listed five
  // items of which three were already `done`, even though its instructions had
  // said to exclude them since #680. A rule the model must re-apply each hour is
  // not a mechanism; an endpoint that cannot return a closed card is. It also
  // removes the sqlite3 CLI from that path, which does not exist on a stock
  // Linux install (#870).
  if (path === '/api/kanban/heartbeat-summary' && method === 'GET') {
    const summary = getHeartbeatKanbanSummary()
    const slim = (c: { id: string; title: string; status: string; priority: string; assignee?: string | null }) => ({
      id: c.id, title: c.title, status: c.status, priority: c.priority, assignee: c.assignee ?? null,
    })
    json(res, {
      urgent: summary.urgent.map(slim),
      waiting: summary.waiting.map(slim),
      counts: {
        urgent: summary.urgent.length,
        in_progress: summary.in_progress.length,
        waiting: summary.waiting.length,
      },
    })
    return true
  }

  if (path === '/api/kanban/labels' && method === 'GET') {
    json(res, listLabels())
    return true
  }

  if (path === '/api/kanban/labels' && method === 'POST') {
    const body = await readBody(req)
    const { name, color } = JSON.parse(body.toString()) as { name?: string; color?: string }
    if (!name || !name.trim()) { json(res, { error: 'Címke neve kötelező' }, 400); return true }
    // Colour is validated against the configured palette (KANBAN_LABEL_COLORS)
    // rather than accepted as free-text, so every label's colour traces back
    // to the single configurable source instead of an arbitrary per-request value.
    const resolvedColor = color && KANBAN_LABEL_COLORS.includes(color) ? color : KANBAN_LABEL_COLORS[0]
    const id = randomUUID().slice(0, 8)
    const label = createLabel({ id, name: name.trim(), color: resolvedColor })
    json(res, label)
    return true
  }

  const labelMatch = path.match(/^\/api\/kanban\/labels\/([^/]+)$/)
  if (labelMatch && method === 'PUT') {
    const id = decodeURIComponent(labelMatch[1])
    const body = await readBody(req)
    const { name, color } = JSON.parse(body.toString()) as { name?: string; color?: string }
    const fields: { name?: string; color?: string } = {}
    if (name !== undefined) {
      if (!name.trim()) { json(res, { error: 'Címke neve kötelező' }, 400); return true }
      fields.name = name.trim()
    }
    if (color !== undefined) {
      fields.color = KANBAN_LABEL_COLORS.includes(color) ? color : KANBAN_LABEL_COLORS[0]
    }
    if (updateLabel(id, fields)) { json(res, { ok: true }); return true }
    json(res, { error: 'Címke nem található' }, 404)
    return true
  }
  if (labelMatch && method === 'DELETE') {
    const id = decodeURIComponent(labelMatch[1])
    if (deleteLabel(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Címke nem található' }, 404)
    return true
  }

  const cardLabelsMatch = path.match(/^\/api\/kanban\/([^/]+)\/labels$/)
  if (cardLabelsMatch && method === 'GET') {
    const cardId = decodeURIComponent(cardLabelsMatch[1])
    json(res, getLabelsForCard(cardId))
    return true
  }
  if (cardLabelsMatch && method === 'POST') {
    const cardId = decodeURIComponent(cardLabelsMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const body = await readBody(req)
    // Accept `id` as an alias for `labelId` -- API callers reasonably send either,
    // since GET /api/kanban/labels returns objects keyed by `id`, not `labelId`.
    const parsed = JSON.parse(body.toString()) as { labelId?: string; id?: string }
    const labelId = parsed.labelId ?? parsed.id
    if (!labelId) { json(res, { error: 'labelId mező kötelező' }, 400); return true }
    if (!getLabel(labelId)) {
      // Common mistake: sending the label's `name` where an `id` is expected -- GET
      // /api/kanban/labels lists both, so this is an easy mix-up. Point at the real id
      // instead of a bare "not found" that reads as if the label doesn't exist at all.
      const byName = listLabels().find((l) => l.name === labelId)
      if (byName) {
        json(res, { error: `Címke nem található id alapján -- a "${labelId}" egy név, nem id. Használd az id-t: ${byName.id}` }, 404)
        return true
      }
      json(res, { error: 'Címke nem található' }, 404)
      return true
    }
    addLabelToCard(cardId, labelId)
    json(res, { ok: true })
    return true
  }

  const cardLabelDeleteMatch = path.match(/^\/api\/kanban\/([^/]+)\/labels\/([^/]+)$/)
  if (cardLabelDeleteMatch && method === 'DELETE') {
    const cardId = decodeURIComponent(cardLabelDeleteMatch[1])
    const labelId = decodeURIComponent(cardLabelDeleteMatch[2])
    if (removeLabelFromCard(cardId, labelId)) { json(res, { ok: true }); return true }
    json(res, { error: 'A kártyán nincs ilyen címke' }, 404)
    return true
  }

  if (path === '/api/kanban-projects' && method === 'GET') {
    json(res, listKanbanProjects())
    return true
  }

  if (path === '/api/kanban/assignees' && method === 'GET') {
    const agents = listAgentNames().map((name) => ({ name, type: 'agent', displayName: readAgentDisplayName(name) || name }))
    json(res, [
      { name: OWNER_NAME, type: 'owner' },
      { name: BOT_NAME, type: 'bot' },
      ...agents,
    ])
    return true
  }

  if (path === '/api/kanban' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const id = randomUUID().slice(0, 8)
    createKanbanCard({ id, ...data })
    json(res, { ok: true, id })
    return true
  }

  const kanbanCardMatch = path.match(/^\/api\/kanban\/([^/]+)$/)
  if (kanbanCardMatch && method === 'PUT') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    if (updateKanbanCard(id, data)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (kanbanCardMatch && method === 'DELETE') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    revertIdeaFromKanban(id)
    if (deleteKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanMoveMatch = path.match(/^\/api\/kanban\/([^/]+)\/move$/)
  if (kanbanMoveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanMoveMatch[1])
    const body = await readBody(req)
    const { status, sort_order, actor } = JSON.parse(body.toString())
    if (moveKanbanCard(id, status, sort_order ?? 0, actor)) {
      // Wake the assigned agent once when the card enters in_progress.
      if (status === 'in_progress') fireKanbanDispatch(id)
      // APG 1.9 §15.2 / §15.3-e (WP6): kanban status->done is a PRODUCER CLAIM.
      //
      // WHAT THIS USED TO DO: `recordAcceptedOutcomeForCard(getDb(), id)`,
      // which wrote `outcome='accepted', evidence='kanban:done'` for every
      // dispatch on the card -- and `cost_per_accepted_task` and
      // `first_pass_acceptance` were computed off those rows. So "accepted"
      // meant "a producer curled its own card to done", which is §28.16's RED
      // condition in production.
      //
      // WHAT IT DOES NOW, in the order it does it:
      //   1. Resolve WHO claimed, server-side (`resolveApgPrincipal`), never
      //      from the request body's `actor`. §11.4 names the body-field
      //      pattern as the thing to refuse and the 1.8 audit found it live.
      //   2. Record the CLAIM with that authority, so the kernel can verify it
      //      on its next feed cycle (§15.3-f). A dispatched agent's own move is
      //      classified PRODUCER_SELF_ASSERTED and is EXCLUDED as evidence, the
      //      same rule `receipt_chain` applies to an author-asserted test
      //      result.
      //   3. Record `producer_completed` -- NOT `accepted` -- for every
      //      existing dispatch. There is no longer any path from a card move to
      //      an `accepted` row; the only writer of that word requires a kernel
      //      verification reference.
      //
      // Both writes are best-effort and neither can block the card move, which
      // is unchanged. Also unchanged: a card that was never instrumented gets
      // no outcome, and history is never backfilled.
      if (status === 'done') {
        const resolved = resolveClaimAuthority(getDb(), id, resolveApgPrincipal(ctx.auth))
        recordCompletionClaimSafe(getDb(), { cardId: id, source: 'kanban_done_move', resolved })
        try {
          recordProducerCompletedOutcomeForCard(getDb(), id, resolved.authority)
        } catch (err) {
          logger.warn({ err, id }, 'WP6: recordProducerCompletedOutcomeForCard failed (card move still succeeded)')
        }
      }
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanArchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/archive$/)
  if (kanbanArchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanArchiveMatch[1])
    // APG 1.9 §25 (1.8 audit finding 3.1): until now the ONLY thing standing
    // between a `curl` with the shared fleet token and the archiving of
    // unaccepted work was web/apg.js. The gate is server-side from here; the
    // client keeps its copy purely as UX. The evaluation runs BEFORE
    // revertIdeaFromKanban, because that call already mutates state.
    const archiveCard = getKanbanCard(id)
    const gate = evaluateArchiveGate({ cardId: id, project: archiveCard?.project ?? null })
    if (!gate.allow) {
      logger.warn({ id, mode: gate.report.mode, reason: gate.report.reason },
        'APG enforced: archive refused server-side')
      json(res, { error: gate.error, apg: gate.report }, gate.status)
      return true
    }
    revertIdeaFromKanban(id)
    if (archiveKanbanCard(id)) { json(res, { ok: true, apg: gate.report }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (path === '/api/kanban/archived' && method === 'GET') {
    const sp      = ctx.url.searchParams
    const q       = sp.get('q')?.trim() || undefined
    const project = sp.get('project')?.trim() || undefined
    const label   = sp.get('label')?.trim() || undefined
    const from    = sp.get('from')  ? Number(sp.get('from'))  : undefined
    const to      = sp.get('to')    ? Number(sp.get('to'))    : undefined
    const limit   = Math.min(Number(sp.get('limit') ?? 0) || Number(getEffectiveSettingValue('KANBAN_ARCHIVED_MAX_ROWS')), 5000)
    const labelsByCard = getLabelsForAllCards()
    const cards = listArchivedKanbanCards({ q, project, label, from, to, limit })
      .map(card => ({ ...card, labels: labelsByCard.get(card.id) ?? [] }))
    json(res, { cards, total: cards.length, limit })
    return true
  }

  const kanbanUnarchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/unarchive$/)
  if (kanbanUnarchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanUnarchiveMatch[1])
    if (unarchiveKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található vagy nincs archiválva' }, 404)
    return true
  }

  const kanbanCommentsMatch = path.match(/^\/api\/kanban\/([^/]+)\/comments$/)
  if (kanbanCommentsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    json(res, getKanbanComments(cardId))
    return true
  }
  if (kanbanCommentsMatch && method === 'POST') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    const body = await readBody(req)
    const { author, content } = JSON.parse(body.toString())
    if (!author || !content) { json(res, { error: 'Szerző és tartalom kötelező' }, 400); return true }
    // Code-side kanban-ref enforcement: rewrite `#<hex8>` references that map
    // to a real card into the human-facing `#<seq>` form before persistence
    // (#75 Cuzcoo dispatch). Random hex / non-matching tokens pass through.
    const normalizedContent = normalizeKanbanRefs(content, getKanbanSeqByIdPrefix)
    json(res, addKanbanComment(cardId, author, normalizedContent))
    return true
  }

  const kanbanEventsMatch = path.match(/^\/api\/kanban\/([^/]+)\/events$/)
  if (kanbanEventsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanEventsMatch[1])
    json(res, getKanbanCardEvents(cardId))
    return true
  }

  const breakdownMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const cardId = decodeURIComponent(breakdownMatch[1])
    const card = getKanbanCard(cardId)
    if (!card) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const existing = getChildCards(cardId)
    if (existing.length > 0) { json(res, { error: 'A kártya már rendelkezik subtask-okkal' }, 409); return true }
    try {
      const result = await generateBreakdown(card.title, card.description)
      json(res, { subtasks: result.subtasks })
    } catch (err) {
      logger.error({ err, cardId }, 'Breakdown generation failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  const acceptMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown\/accept$/)
  if (acceptMatch && method === 'POST') {
    const parentId = decodeURIComponent(acceptMatch[1])
    const parent = getKanbanCard(parentId)
    if (!parent) { json(res, { error: 'Szülő kártya nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description: string; assignee: string | null; priority: string }>
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Subtask lista kötelező' }, 400)
      return true
    }
    const db = getDb()
    const created = db.transaction(() => {
      const ids: string[] = []
      for (const st of subtasks) {
        const id = randomUUID().slice(0, 8).toUpperCase()
        createKanbanCard({
          id,
          title: st.title,
          description: st.description,
          assignee: st.assignee ?? undefined,
          priority: (st.priority as any) ?? 'normal',
          project: parent.project ?? undefined,
          parent_id: parentId,
        })
        ids.push(id)
      }
      addKanbanComment(parentId, BOT_NAME, `Auto-breakdown: ${ids.length} subtask létrehozva (${ids.join(', ')})`)
      return ids
    })()
    json(res, { ok: true, created })
    return true
  }

  const childrenMatch = path.match(/^\/api\/kanban\/([^/]+)\/children$/)
  if (childrenMatch && method === 'GET') {
    const parentId = decodeURIComponent(childrenMatch[1])
    json(res, getChildCards(parentId))
    return true
  }

  return false
}
