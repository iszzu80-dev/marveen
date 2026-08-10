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
  // The steps print one or more JSON lines. Keep the last parseable one; if none
  // parses, keep the raw tail rather than pretending the step produced nothing.
  let parsed: unknown = null
  for (const line of out.split('\n')) {
    const brace = line.indexOf('{')
    if (brace < 0) continue
    try { parsed = JSON.parse(line.slice(brace)) } catch { /* not this line */ }
  }
  report[s.name] = parsed ?? { raw: out.slice(-500) }

  // A step can exit 0 and still say it failed. The progression runner does
  // exactly this when no interpreter is configured: it prints
  // {failed:true, error:"..."} and returns 0, because a missing key is not a
  // crash. Reading only the exit code would file that under "cycle fine" — the
  // dead-monitor-reports-green shape. So the payload is inspected too.
  const p = parsed as { failed?: boolean; error?: string } | null
  if (p && p.failed === true) {
    problems.push(`${s.name}: ${p.error ?? 'reported failed:true'}`)
  }
}

report.problems = problems
console.log(JSON.stringify(report, null, 1))
process.exit(problems.length ? 1 : 0)
