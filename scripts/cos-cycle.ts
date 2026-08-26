#!/usr/bin/env npx tsx
/**
 * One COS cycle: the §8 inbound chain, end to end, as a program.
 *
 * F-17 (review 2026-08-10). These four steps used to live as four `npx tsx`
 * lines inside a scheduled LLM prompt, run every ten minutes. §21's closing
 * sentence is "no prompt-only done", and this is why: every step is a RULE, none
 * is a judgement, and a turn that reads three of the four lines and stops is
 * indistinguishable from one that ran all four and found nothing. The failure
 * mode is silent by construction.
 *
 * It SPAWNS the existing scripts rather than reimplementing them. Reaching into
 * their internals would create a second definition of each step, and the second
 * definition is the one that quietly drifts. This file's whole job is
 * sequencing, error isolation and an exit code.
 *
 * What is deliberately NOT here: interpreting a case's goal. That needs
 * judgement, so it stays with the heartbeat runner. The line is not
 * agent-versus-script, it is judgement-versus-rule.
 *
 * One step failing does not stop the others — a stuck thread download must not
 * also stop batch closure. Every failure lands in `problems`, and a non-empty
 * `problems` exits 1, because a cycle that half-ran must not look like one that
 * finished.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { standardFeatureResult, recordFeatureRun, type FeatureRunResult, type VerificationStatus } from '../src/cos/consumer-manifest.js'
import { getDb, initDatabase } from '../src/db.js'
import {
  declaredScheduledIdentity, scheduledIdentityEnv,
} from '../src/identity/scheduled-task-identity.js'

/**
 * W10 identity propagation (Istvan's decision 2026-08-25 §1).
 *
 * The cycle does not RUN its steps, it SPAWNS them -- so an identity built here
 * and never crossing the process boundary is an identity the acting code does
 * not have. Each step therefore gets ITS OWN declared identity in its
 * environment, keyed by `task` below rather than by the report key: the report
 * key is a display name (`plannedDigest`) and the grant is about the program
 * (`cos-planned-digest`). Tying authority to a display name is how a rename
 * silently changes what something may do.
 *
 * The environment carries identifiers only. The capability scope is re-derived
 * in the child from the declaration, so a step cannot widen its own grant by
 * editing an env var before spawning something else.
 */
const RUN_ID = `cos-cycle-${randomUUID()}`

interface Step { name: string; args: string[]; task: string }

const STEPS: Step[] = [
  { name: 'progression', args: ['scripts/progression-heartbeat-runner.ts'], task: 'progression' },
  // P1: a tabla es a motor UGYANARROL az ugyrol ugyanazt mondja-e. Az elso
  // meresen az Invariant A a motorban 166/167-en allt, a tablan 0/146-on --
  // nem azert, mert a tabla tevedett az ugyrol, hanem mert HALLGATOTT rola, es
  // semmi nem egyeztette a kettot. A lepes ELOL van: minden utana kovetkezo
  // meres a tablarol olvas, es egy nem-egyeztetett tabla hazudik nekik.
  { name: 'reconcile', args: ['scripts/cos-reconcile-projection.ts'], task: 'cos-reconcile-projection' },
  { name: 'batches', args: ['scripts/cos-close-batches.ts'], task: 'cos-close-batches' },
  { name: 'threads', args: ['scripts/cos-fetch-threads.ts', '--limit', '10'], task: 'cos-fetch-threads' },
  { name: 'followups', args: ['scripts/cos-draft-followups.ts', '--limit', '5'], task: 'cos-draft-followups' },
  // A megfogalmazas es a FELSZINRE HOZASA ket kulon lepes, ugyanazert, amiert a
  // kerdes megirasa es kikuldese az: enelkul egy PLANNED sor, amirol senki nem
  // szol, ugy nez ki, mint "nem volt mit megfogalmazni". A lepes naponta egyszer
  // szolal meg (sajat napi-naplo nyugtaja a kapu), es a nulla esetet is kimondja.
  { name: 'plannedDigest', args: ['scripts/cos-planned-digest.ts'], task: 'cos-planned-digest' },
  // Ugyanaz az alak, mas targy: a radar celar alatti, de NEM igazolt
  // szallithatosagu talalatai. Ezek nem riasztanak (nem mondjuk Istvannak hogy
  // vegye meg, amirol nem tudjuk hogy megkapja) -- de ha eltunnenek, a "semmi
  // nem volt eleg olcso" es a "harom is volt, csak nem tudtuk ellenorizni"
  // megkulonboztethetetlen lenne. Naponta egyszer, sajat nyugtaval, a nulla
  // esetet is kimondva.
  { name: 'radarDigest', args: ['scripts/cos-radar-digest.ts'], task: 'cos-radar-digest' },
  // A felebredt ugyek felszinre hozasa. A `next_wake_at`-nak volt iroja
  // (setNextWake) es olvasoja (dueCases), a tick hivta is az olvasot -- es a
  // sorok helyett a HOSSZUKAT tartotta meg, tehat egy ebresztesre soha semmi
  // nem tudott cselekedni, es ezert nem is toltotte ki senki (0/61). Ez a
  // hianyzo fogyaszto. Csendes, ha semmi nem ebredt: ez esemeny-riasztas, nem
  // kivonat.
  { name: 'wakeAlert', args: ['scripts/cos-wake-alert.ts'], task: 'cos-wake-alert' },
  // Hatarido, ami csak PROZABAN letezik (2026-08-16, eec5ca9f). Ket
  // auto-berles ugy next_action-jeben ez allt: "DONTES 2026-08-16 10:00 elott",
  // mikozben a datum-oszlopaik a ket nappal kesobbi atvetelre mutattak -- tehat
  // egyetlen datum-vezerelt felulet sem latta a hataridot, es a napi kivonat
  // sem emlitette. A lepes NEM elemez datumot: azt kerdezi, hogy egy ugy
  // beszel-e hataridorol UGY, hogy kozben EGYETLEN datum-mezoje sincs kitoltve.
  // Mindket nevterre fut, es a nullat is kimondja.
  { name: 'deadlineAudit', args: ['scripts/cos-deadline-audit.ts'], task: 'cos-deadline-audit' },
  // A kerdes megirasa es a KIKULDESE ket kulon lepes: ha egybe lennenek, egy
  // kezbesitesi hiba ugy nezne ki, mint "nincs mit kerdezni".
  // W12 / §6.7. A parked ingest row (RECOVERY_REQUIRED) is NON-TERMINAL, so it
  // pins the account history cursor -- and until this step existed nothing in
  // the codebase read those rows: no retry, no listing, no alert, no test. The
  // only symptom would have been "batch not terminal", which the healthy case
  // reports too. The step delivers nothing (no EXTERNAL_EFFECT grant); the
  // internal COS Control view is where escalated rows are read.
  { name: 'recoveryQueue', args: ['scripts/cos-recovery-queue.ts'], task: 'cos-recovery-queue' },
  { name: 'channel', args: ['scripts/cos-channel-send.ts'], task: 'cos-channel-send' },
  // A bejovo oldal: Istvan valasza a CoS-csatornarol visszaer az ugyhez.
  // Enelkul a szetvalasztas rosszabb lenne az egycsatornas vilagnal --
  // egy chatbe valaszolna, amit senki nem olvas.
  { name: 'inbox', args: ['scripts/cos-channel-poll.ts'], task: 'cos-channel-poll' },
]

const problems: string[] = []
const report: Record<string, unknown> = { at: new Date().toISOString() }

/**
 * ACP v1.4.5 CPP telemetry adapter.
 *
 * Legacy steps do not all expose the same counters yet. The adapter is
 * deliberately conservative: it only uses explicitly named numeric counters.
 * If a successful step exposes no trustworthy counters, the result is UNKNOWN —
 * never a fabricated NO_DATA/zero. That distinction is the release invariant.
 */
function numeric(o: Record<string, unknown> | null, keys: string[]): number | null {
  if (!o) return null
  for (const key of keys) {
    const v = o[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return null
}

function arrayCount(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null
  const v = o[key]
  return Array.isArray(v) ? v.length : null
}

/** Sum a counter that lives one level down under `personal` and `zst`.
 *
 *  Added 2026-08-24 during the pinned-cutover: five of ten steps reported
 *  outcome=UNKNOWN ("successful exit but payload exposes no CPP counters"), and
 *  every one of them was in fact exposing usable numbers -- just nested, or under
 *  a name this normaliser did not know. UNKNOWN was therefore telling the truth
 *  about the READER, not about the step. That is worth being precise about: an
 *  UNKNOWN that means "I did not look properly" is a different defect from one
 *  that means "this step cannot say what it did", and only the second is the
 *  thing the semantics were built to surface. */
function nestedSum(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null
  let total: number | null = null
  for (const side of ['personal', 'zst']) {
    const branch = o[side]
    if (branch && typeof branch === 'object') {
      const v = (branch as Record<string, unknown>)[key]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) total = (total ?? 0) + v
    }
  }
  return total
}

/** Length of an array nested under `personal` and `zst`, summed. */
function nestedArrayCount(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null
  let total: number | null = null
  for (const side of ['personal', 'zst']) {
    const branch = o[side]
    if (branch && typeof branch === 'object') {
      const v = (branch as Record<string, unknown>)[key]
      if (Array.isArray(v)) total = (total ?? 0) + v.length
    }
  }
  return total
}

/** Add two counters when at least one of them is present. Returns null only when
 *  BOTH are absent, so a step that reports `drafted: []` and `skipped: 17` is
 *  measured rather than declared unknowable. */
function sumOf(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}

function progressionCount(o: Record<string, unknown> | null): number | null {
  if (!o) return null
  const p = typeof o.personal === 'number' ? o.personal : null
  const z = typeof o.zst === 'number' ? o.zst : null
  return p !== null && z !== null ? p + z : null
}

function cppResult(
  step: string,
  payload: Record<string, unknown> | null,
  hardFailure: string | null,
): FeatureRunResult {
  const nestedHeartbeat = payload?.heartbeat && typeof payload.heartbeat === 'object'
    ? payload.heartbeat as Record<string, unknown> : null
  const source = nestedHeartbeat ?? payload

  const failures = arrayCount(source, 'failures') ?? arrayCount(payload, 'failures') ?? 0
  if (hardFailure || failures > 0 || source?.failed === true || payload?.failed === true) {
    return standardFeatureResult({
      examined: numeric(source, ['examined', 'checked', 'scanned', 'processed']) ?? progressionCount(source) ?? 0,
      matched: numeric(source, ['matched', 'pending', 'due', 'candidates']) ?? 0,
      acted: numeric(source, ['acted', 'sent', 'drafted', 'closed', 'cleared', 'asked']) ?? progressionCount(source) ?? 0,
      failed: Math.max(1, failures),
      outcome: 'FAILED',
      reason: hardFailure ?? `${step} reported ${Math.max(1, failures)} failure(s)`,
    })
  }

  // `count` and `woken`/`drafted` are added to the name lists rather than special-
  // cased per step: a per-step table would have to be edited every time a step is
  // added, and the step that nobody remembered to add would report UNKNOWN while
  // looking exactly like a step that genuinely cannot say what it did.
  const examined = numeric(source, ['examined', 'checked', 'scanned', 'processed', 'read', 'count'])
    ?? progressionCount(source)
    ?? nestedSum(source, 'examined')
    ?? sumOf(arrayCount(source, 'drafted'), numeric(source, ['skipped']))
  const matched = numeric(source, ['matched', 'pending', 'due', 'candidates'])
    ?? arrayCount(source, 'woken')
    ?? nestedArrayCount(source, 'proseOnly')
  const acted = numeric(source, ['acted', 'sent', 'drafted', 'closed', 'cleared', 'asked', 'closures'])
    ?? progressionCount(source)
    ?? arrayCount(source, 'drafted')
    ?? arrayCount(source, 'woken')
    ?? (typeof source?.posted === 'boolean' ? (source.posted ? 1 : 0) : null)

  // No counters means absence of evidence, not evidence of zero work.
  if (examined === null && matched === null && acted === null) {
    return {
      examined: 0, matched: 0, acted: 0, failed: 0, outcome: 'UNKNOWN',
      reason: `${step}: successful exit but payload exposes no CPP counters`,
    }
  }

  const e = examined ?? Math.max(matched ?? 0, acted ?? 0)
  const m = matched ?? Math.min(e, acted ?? 0)
  const a = acted ?? 0
  return standardFeatureResult({
    examined: e, matched: m, acted: a, failed: 0,
    reason: `${step}: normalized from explicit step counters`,
  })
}

/**
 * W14 / §8.7 — RUN INTEGRITY, written where every step passes.
 *
 * The table (`cos_feature_runs`) has existed since ACP v1.4.5 and, measured on
 * the live store on 2026-08-26, held ZERO rows: `recordFeatureRun` had no
 * production caller anywhere. The third instance of this codebase's
 * characteristic defect in three packets — correct code with no consumer.
 *
 * It is written HERE, in the parent, rather than in each step: the cycle is the
 * one place every step passes through, so a new step is recorded without its
 * author remembering to. The cost is that the parent sees only what a step
 * PRINTS, which is why the cursor and verification fields are read out of the
 * step payload rather than invented.
 *
 * VERIFICATION IS DERIVED FROM THE GRANT, not from optimism. A step whose
 * scheduled-task grant has no EXTERNAL_EFFECT has nothing to read back, and
 * NOT_APPLICABLE is its honest answer. A step that MAY act outside and did act,
 * without saying it verified, is UNVERIFIED — so §8.7's rule bites and the run
 * lands as PARTIAL rather than SUCCESS.
 */
function verificationFor(
  capabilities: readonly string[], payload: Record<string, unknown> | null, cpp: FeatureRunResult,
): VerificationStatus {
  if (!capabilities.includes('EXTERNAL_EFFECT')) return 'NOT_APPLICABLE'
  if (payload && (payload.verified === true || payload.readback === 'VERIFIED')) return 'VERIFIED'
  return cpp.acted > 0 ? 'UNVERIFIED' : 'NOT_APPLICABLE'
}

/** A cursor a step reported, if it reported one. Never derived from anything
 *  else: a cursor field filled in by the parent would be a claim the step never
 *  made. */
const cursorField = (payload: Record<string, unknown> | null, key: string): string | null => {
  const v = payload?.[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null
}

/** One §8.7 row per step. Never throws: a run ledger that can take the cycle
 *  down would be a monitoring surface that causes the outage it reports. */
function recordRun(
  step: Step, identity: { capabilityScope: readonly string[] },
  cpp: FeatureRunResult, payload: Record<string, unknown> | null, startedAt: number,
): string {
  try {
    return recordFeatureRun(getDb(), {
      runId: `${RUN_ID}:${step.name}`, featureId: step.task, domain: 'personal',
      result: cpp, startedAt, finishedAt: Math.floor(Date.now() / 1000),
      integrity: {
        capabilityResult: identity.capabilityScope.join(','),
        inputCursor: cursorField(payload, 'cursorBefore'),
        finalCursor: cursorField(payload, 'cursor') ?? cursorField(payload, 'cursorAfter'),
        pendingWrites: typeof payload?.pending === 'number' ? payload.pending : null,
        sideEffects: payload?.sent ?? payload?.posted ?? null,
        verificationStatus: verificationFor(identity.capabilityScope, payload, cpp),
      },
    })
  } catch (err) {
    problems.push(`${step.name}: run ledger write failed: ${err instanceof Error ? err.message : String(err)}`)
    return 'UNKNOWN'
  }
}

initDatabase()

for (const s of STEPS) {
  const stepIdentity = declaredScheduledIdentity(s.task, RUN_ID)
  const startedAt = Math.floor(Date.now() / 1000)
  const r = spawnSync('npx', ['tsx', ...s.args], {
    encoding: 'utf8',
    env: { ...process.env, ...scheduledIdentityEnv(stepIdentity) },
    // A hung step must not hold the ten-minute cycle open forever; the next one
    // would then overlap this one.
    timeout: 8 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = (r.stdout ?? '').trim()
  const err = (r.stderr ?? '').trim()
  if (r.status !== 0 || r.error) {
    const why = r.error ? String(r.error.message) : `exit ${r.status}`
    const failedCpp = cppResult(s.name, null, why)
    report[s.name] = {
      failed: true, error: why, stderr: err.slice(-500),
      cpp: failedCpp,
      runStatus: recordRun(s, stepIdentity, failedCpp, null, startedAt),
    }
    problems.push(`${s.name}: ${why}`)
    continue
  }
  // The steps print one or more JSON lines. MERGE them, do not keep only the
  // last: the progression runner prints Migration, Heartbeat and GoalEnrichment
  // on separate lines, and keeping the last silently threw away every heartbeat
  // counter — including the one added to measure the §10.8 trigger contract.
  // Found by looking for those counters and finding nulls. A reporter that
  // quietly drops most of what it was given is the same shape as the failures
  // this runner exists to catch.
  let parsed: Record<string, unknown> | null = null
  for (const line of out.split('\n')) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    try {
      const obj = JSON.parse(line.slice(brace)) as Record<string, unknown>
      parsed = { ...(parsed ?? {}), ...obj }
    } catch { /* not this line */ }
  }

  const stepReport: Record<string, unknown> = parsed ? { ...parsed } : { raw: out.slice(-500) }
  const cpp = cppResult(s.name, parsed, null)
  stepReport.cpp = cpp
  stepReport.runStatus = recordRun(s, stepIdentity, cpp, parsed, startedAt)
  report[s.name] = stepReport

  // A step can exit 0 and still say it failed. The progression runner does
  // exactly this when no interpreter is configured: it prints
  // {failed:true, error:"..."} and returns 0, because a missing key is not a
  // crash. Reading only the exit code would file that under "cycle fine" — the
  // dead-monitor-reports-green shape. So the payload is inspected too.
  //
  // NESTED payloads are inspected too, one level down. The heartbeat runner
  // reports its subsystems under their own keys (`reader: {...}`) so that two
  // subsystems' counters cannot overwrite each other in this merge — and a
  // top-level-only check would then have walked straight past
  // `reader: {failed: true}`. The nesting that fixed one silent failure would
  // have created another one directly below it.
  const p = parsed as Record<string, unknown> | null
  if (p) {
    const failedIn = (o: unknown): { failed?: boolean; error?: string } | null =>
      (o && typeof o === 'object' && (o as { failed?: unknown }).failed === true)
        ? (o as { failed?: boolean; error?: string }) : null

    // A NON-EMPTY `failures` ARRAY IS ALSO A FAILURE.
    //
    // Found live on 2026-08-11, by this runner's own output: the channel step
    // could not deliver an owner question ("telegram sendMessage failed: fetch
    // failed"), reported `{pending: 1, sent: 0, failures: [1]}`, exited 0 — and
    // the cycle printed `problems: []`. A question that never reached Istvan was
    // filed under "cycle fine".
    //
    // The old check looked for `failed: true` alone, which is the shape ONE step
    // uses. Three others (channel, reader, goal enrichment) report per-item
    // errors in a `failures` array instead, precisely because one bad case must
    // not stop the batch — and that design turned every one of those errors
    // invisible at this level. The same doctrine this file's own header states:
    // a cycle that half-ran must not look like one that ran clean.
    const failureList = (o: unknown): Array<{ caseId?: string; error?: string }> | null => {
      if (!o || typeof o !== 'object') return null
      const f = (o as { failures?: unknown }).failures
      return Array.isArray(f) && f.length > 0 ? f as Array<{ caseId?: string; error?: string }> : null
    }
    const describe = (list: Array<{ caseId?: string; error?: string }>): string => {
      const first = list[0]
      const rest = list.length > 1 ? ` (+${list.length - 1} more)` : ''
      return `${list.length} failed: ${first?.caseId ?? '?'}: ${first?.error ?? 'no error text'}${rest}`
    }

    const self = failedIn(p)
    if (self) problems.push(`${s.name}: ${self.error ?? 'reported failed:true'}`)
    const selfFailures = failureList(p)
    if (selfFailures) problems.push(`${s.name}: ${describe(selfFailures)}`)
    for (const [key, value] of Object.entries(p)) {
      const nested = failedIn(value)
      if (nested) problems.push(`${s.name}/${key}: ${nested.error ?? 'reported failed:true'}`)
      const nestedFailures = failureList(value)
      if (nestedFailures) problems.push(`${s.name}/${key}: ${describe(nestedFailures)}`)
    }
  }
}

report.problems = problems
console.log(JSON.stringify(report, null, 1))
process.exit(problems.length ? 1 : 0)
