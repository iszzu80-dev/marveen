#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  parseProgramWorkstream, parseResultText, ReviewJobStore, runReview,
  type ProgramWorkstream, type ReviewKind, type ReviewRequest,
} from '../src/cos/development-control/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const controlRoot = join(repoRoot, 'store', 'development-control-loop')
const store = new ReviewJobStore(controlRoot)
const args = process.argv.slice(2)
const command = args.shift()

function values(flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[++i])
  return out
}
function value(flag: string): string | undefined { return values(flag)[0] }
function git(...gitArgs: string[]): string { return execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim() }
function required(flag: string): string { const v = value(flag); if (!v) throw new Error(`${flag} is required`); return v }

function makeRequest(): ReviewRequest {
  const workItem = required('--work-item')
  const stream = parseProgramWorkstream(value('--workstream') ?? 'COS_P2') as ProgramWorkstream
  const candidate = value('--candidate-sha') ?? git('rev-parse', 'HEAD')
  const base = value('--base-sha') ?? git('merge-base', candidate, 'develop')
  const kind = (value('--review-kind') ?? 'IMPLEMENTATION') as ReviewKind
  const jobId = value('--job-id') ?? `${workItem}-${candidate.slice(0, 12)}-${kind.toLowerCase()}`
  return {
    schema_version: 1, job_id: jobId, work_item_id: workItem, program_workstream: stream,
    review_kind: kind, base_sha: base, candidate_sha: candidate,
    acceptance_criteria: values('--acceptance').length ? values('--acceptance') : ['Verify the exact candidate against the canonical work item acceptance criteria referenced by this packet.'],
    relevant_files: values('--file'), relevant_diff_refs: values('--diff-ref'), evidence_refs: values('--evidence-ref'), test_results: values('--test-result'),
    requested_checks: values('--check').length ? values('--check') : ['correctness', 'scope', 'regression risk', 'evidence sufficiency', 'authority boundary'],
    authority_constraints: { codex_is_read_only: true, marveen_is_sole_orchestrator: true, marveen_is_sole_owner_facing: true, no_canonical_state_writes: true, no_owner_contact: true },
  }
}

async function main(): Promise<void> {
  if (command === 'status') {
    console.log(JSON.stringify({ schema_version: 1, role: 'NON_CANONICAL_LOCAL_IPC', root: controlRoot, watches_or_polls: false, applies_results: false, owner_facing: false, canonical_truth: 'existing Marveen stores only' }, null, 2)); return
  }
  if (command === 'prepare-review') {
    const prepared = store.prepare(makeRequest()); console.log(JSON.stringify({ job_id: prepared.request.job_id, request_path: store.paths(prepared.request.job_id).request, reused_valid_result: prepared.reused }, null, 2)); return
  }
  if (command === 'run-review') {
    const out = await runReview({ request: makeRequest(), repoRoot, store, timeoutMs: Number(value('--timeout-ms') ?? 600_000) })
    console.log(JSON.stringify(out, null, 2)); process.exitCode = out.result ? 0 : 1; return
  }
  if (command === 'validate-result') {
    const resultPath = args.find(a => !a.startsWith('--'))
    if (!resultPath || !existsSync(resultPath)) throw new Error('validate-result requires an existing result path')
    const requestPath = value('--request') ?? join(dirname(resolve(resultPath)), 'request.json')
    const request = JSON.parse(readFileSync(requestPath, 'utf8')) as ReviewRequest
    const result = parseResultText(readFileSync(resultPath, 'utf8'), request)
    console.log(JSON.stringify({ valid: true, job_id: result.job_id, candidate_sha: result.candidate_sha, verdict: result.verdict }, null, 2)); return
  }
  throw new Error('usage: cos-dev-control.ts status | prepare-review --work-item <id> [options] | run-review --work-item <id> [options] | validate-result <path> [--request <path>]')
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 })
