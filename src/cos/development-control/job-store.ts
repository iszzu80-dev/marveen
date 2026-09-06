import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseResultText, validateReviewRequest } from './contract.js'
import type { CompletedReviewMetadata, ReviewAttemptMetadata, ReviewLease, ReviewRequest, ReviewResult } from './types.js'

export const MAX_TECHNICAL_ATTEMPTS = 3
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown
const sameIdentity = (a: ReviewRequest, b: ReviewRequest) => a.job_id === b.job_id && a.work_item_id === b.work_item_id && a.candidate_sha === b.candidate_sha

export class ReviewJobStore {
  constructor(readonly root: string, readonly now: () => Date = () => new Date()) {}
  jobDir(jobId: string): string { return join(this.root, 'jobs', jobId) }
  paths(jobId: string) { const d = this.jobDir(jobId); return { dir: d, attempts: join(d, 'attempts'), request: join(d, 'request.json'), schema: join(d, 'result.schema.json'), lease: join(d, 'lease.json'), completed: join(d, 'completed.json') } }
  attemptPaths(jobId: string, attempt: number) { const dir = join(this.paths(jobId).attempts, String(attempt)); return { dir, schema: join(dir, 'result.schema.json'), result: join(dir, 'result.json'), stdout: join(dir, 'stdout.txt'), stderr: join(dir, 'stderr.txt'), metadata: join(dir, 'metadata.json') } }

  prepare(requestInput: ReviewRequest): { request: ReviewRequest; reused: boolean } {
    const request = validateReviewRequest(requestInput)
    const p = this.paths(request.job_id); mkdirSync(p.dir, { recursive: true })
    if (existsSync(p.request)) {
      const prior = validateReviewRequest(json(p.request))
      if (!sameIdentity(prior, request)) throw new Error('job identity collision: job_id is already bound to another work item or SHA')
      return { request: prior, reused: this.readReusableResult(prior) !== null }
    }
    writeFileSync(p.request, JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return { request, reused: false }
  }

  readReusableResult(request: ReviewRequest): { result: ReviewResult; completion: CompletedReviewMetadata } | null {
    const completedPath = this.paths(request.job_id).completed
    if (!existsSync(completedPath)) return null
    try {
      const completion = json(completedPath) as CompletedReviewMetadata
      if (completion.schema_version !== 1 || completion.status !== 'COMPLETED_VALID' || completion.job_id !== request.job_id || completion.work_item_id !== request.work_item_id || completion.candidate_sha !== request.candidate_sha || completion.process_exit_code !== 0 || completion.timed_out !== false || !Number.isInteger(completion.attempt) || completion.attempt < 1) return null
      const attemptPaths = this.attemptPaths(request.job_id, completion.attempt)
      if (completion.result_path !== `attempts/${completion.attempt}/result.json` || !existsSync(attemptPaths.metadata) || !existsSync(attemptPaths.result)) return null
      const attempt = json(attemptPaths.metadata) as ReviewAttemptMetadata
      if (attempt.status !== 'COMPLETED_VALID' || attempt.job_id !== request.job_id || attempt.work_item_id !== request.work_item_id || attempt.candidate_sha !== request.candidate_sha || attempt.attempt !== completion.attempt || attempt.process_exit_code !== 0 || attempt.timed_out !== false || attempt.result_sha256 !== completion.result_sha256) return null
      const body = readFileSync(attemptPaths.result, 'utf8')
      if (createHash('sha256').update(body).digest('hex') !== completion.result_sha256) return null
      return { result: parseResultText(body, request), completion }
    } catch { return null }
  }

  acquireLease(request: ReviewRequest, ttlMs: number, holderId: string = randomUUID()): ReviewLease {
    const p = this.paths(request.job_id); mkdirSync(p.dir, { recursive: true })
    mkdirSync(p.attempts, { recursive: true })
    let priorAttempt = readdirSync(p.attempts).filter(name => /^\d+$/.test(name)).reduce((max, n) => Math.max(max, Number(n)), 0)
    if (existsSync(p.lease)) {
      const prior = json(p.lease) as ReviewLease
      if (prior.work_item_id !== request.work_item_id || prior.candidate_sha !== request.candidate_sha) throw new Error('lease identity mismatch')
      if (Date.parse(prior.expires_at) > this.now().getTime()) throw new Error('review lease is already held')
      priorAttempt = Math.max(priorAttempt, prior.attempt)
      renameSync(p.lease, join(p.dir, `lease.expired.${prior.attempt}.json`))
    }
    const attempt = priorAttempt + 1
    if (attempt > MAX_TECHNICAL_ATTEMPTS) throw new Error('technical retry limit exhausted')
    const acquired = this.now(); const lease: ReviewLease = { schema_version: 1, job_id: request.job_id, work_item_id: request.work_item_id, candidate_sha: request.candidate_sha, holder_id: holderId, acquired_at: acquired.toISOString(), expires_at: new Date(acquired.getTime() + ttlMs).toISOString(), attempt }
    const fd = openSync(p.lease, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(lease, null, 2) + '\n') } finally { closeSync(fd) }
    return lease
  }

  writeAttempt(meta: ReviewAttemptMetadata): void {
    const p = this.attemptPaths(meta.job_id, meta.attempt); mkdirSync(p.dir, { recursive: true })
    this.atomicJson(p.metadata, meta)
  }

  commitCompleted(meta: ReviewAttemptMetadata): CompletedReviewMetadata {
    if (meta.status !== 'RESULT_VALIDATED' || meta.process_exit_code !== 0 || meta.timed_out || !meta.result_sha256) throw new Error('only a successfully validated attempt can complete')
    const completion: CompletedReviewMetadata = { schema_version: 1, status: 'COMPLETED_VALID', job_id: meta.job_id, work_item_id: meta.work_item_id, candidate_sha: meta.candidate_sha, attempt: meta.attempt, process_exit_code: 0, timed_out: false, result_path: meta.result_path, result_sha256: meta.result_sha256, completed_at: this.now().toISOString() }
    const completedAttempt = { ...meta, status: 'COMPLETED_VALID' as const }
    this.writeAttempt(completedAttempt)
    this.atomicJson(this.paths(meta.job_id).completed, completion)
    return completion
  }

  releaseLease(lease: ReviewLease): void {
    const path = this.paths(lease.job_id).lease
    if (!existsSync(path)) return
    const current = json(path) as ReviewLease
    if (current.holder_id !== lease.holder_id) throw new Error('cannot release another lease holder')
    unlinkSync(path)
  }

  private atomicJson(path: string, value: unknown): void {
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  }
}
