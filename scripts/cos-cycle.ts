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

interface Step { name: string; args: string[] }

const STEPS: Step[] = [
  { name: 'progression', args: ['scripts/progression-heartbeat-runner.ts'] },
  { name: 'batches', args: ['scripts/cos-close-batches.ts'] },
  { name: 'threads', args: ['scripts/cos-fetch-threads.ts', '--limit', '10'] },
  { name: 'followups', args: ['scripts/cos-draft-followups.ts', '--limit', '5'] },
  // A megfogalmazas es a FELSZINRE HOZASA ket kulon lepes, ugyanazert, amiert a
  // kerdes megirasa es kikuldese az: enelkul egy PLANNED sor, amirol senki nem
  // szol, ugy nez ki, mint "nem volt mit megfogalmazni". A lepes naponta egyszer
  // szolal meg (sajat napi-naplo nyugtaja a kapu), es a nulla esetet is kimondja.
  { name: 'plannedDigest', args: ['scripts/cos-planned-digest.ts'] },
  // Ugyanaz az alak, mas targy: a radar celar alatti, de NEM igazolt
  // szallithatosagu talalatai. Ezek nem riasztanak (nem mondjuk Istvannak hogy
  // vegye meg, amirol nem tudjuk hogy megkapja) -- de ha eltunnenek, a "semmi
  // nem volt eleg olcso" es a "harom is volt, csak nem tudtuk ellenorizni"
  // megkulonboztethetetlen lenne. Naponta egyszer, sajat nyugtaval, a nulla
  // esetet is kimondva.
  { name: 'radarDigest', args: ['scripts/cos-radar-digest.ts'] },
  // A felebredt ugyek felszinre hozasa. A `next_wake_at`-nak volt iroja
  // (setNextWake) es olvasoja (dueCases), a tick hivta is az olvasot -- es a
  // sorok helyett a HOSSZUKAT tartotta meg, tehat egy ebresztesre soha semmi
  // nem tudott cselekedni, es ezert nem is toltotte ki senki (0/61). Ez a
  // hianyzo fogyaszto. Csendes, ha semmi nem ebredt: ez esemeny-riasztas, nem
  // kivonat.
  { name: 'wakeAlert', args: ['scripts/cos-wake-alert.ts'] },
  // Hatarido, ami csak PROZABAN letezik (2026-08-16, eec5ca9f). Ket
  // auto-berles ugy next_action-jeben ez allt: "DONTES 2026-08-16 10:00 elott",
  // mikozben a datum-oszlopaik a ket nappal kesobbi atvetelre mutattak -- tehat
  // egyetlen datum-vezerelt felulet sem latta a hataridot, es a napi kivonat
  // sem emlitette. A lepes NEM elemez datumot: azt kerdezi, hogy egy ugy
  // beszel-e hataridorol UGY, hogy kozben EGYETLEN datum-mezoje sincs kitoltve.
  // Mindket nevterre fut, es a nullat is kimondja.
  { name: 'deadlineAudit', args: ['scripts/cos-deadline-audit.ts'] },
  // A kerdes megirasa es a KIKULDESE ket kulon lepes: ha egybe lennenek, egy
  // kezbesitesi hiba ugy nezne ki, mint "nincs mit kerdezni".
  { name: 'channel', args: ['scripts/cos-channel-send.ts'] },
  // A bejovo oldal: Istvan valasza a CoS-csatornarol visszaer az ugyhez.
  // Enelkul a szetvalasztas rosszabb lenne az egycsatornas vilagnal --
  // egy chatbe valaszolna, amit senki nem olvas.
  { name: 'inbox', args: ['scripts/cos-channel-poll.ts'] },
]

const problems: string[] = []
const report: Record<string, unknown> = { at: new Date().toISOString() }

for (const s of STEPS) {
  const r = spawnSync('npx', ['tsx', ...s.args], {
    encoding: 'utf8',
    // A hung step must not hold the ten-minute cycle open forever; the next one
    // would then overlap this one.
    timeout: 8 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = (r.stdout ?? '').trim()
  const err = (r.stderr ?? '').trim()
  if (r.status !== 0 || r.error) {
    const why = r.error ? String(r.error.message) : `exit ${r.status}`
    report[s.name] = { failed: true, error: why, stderr: err.slice(-500) }
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
  report[s.name] = parsed ?? { raw: out.slice(-500) }

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
