import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseResultText, validateReviewRequest } from './contract.js'
import type { ReviewAttemptMetadata, ReviewLease, ReviewRequest, ReviewResult } from './types.js'

export const MAX_TECHNICAL_ATTEMPTS = 3
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown
const sameIdentity = (a: ReviewRequest, b: ReviewRequest) => a.job_id === b.job_id && a.work_item_id === b.work_item_id && a.candidate_sha === b.candidate_sha

export class ReviewJobStore {
  constructor(readonly root: string, readonly now: () => Date = () => new Date()) {}
  jobDir(jobId: string): string { return join(this.root, 'jobs', jobId) }
  paths(jobId: string) { const d = this.jobDir(jobId); return { dir: d, request: join(d, 'request.json'), result: join(d, 'result.json'), schema: join(d, 'result.schema.json'), lease: join(d, 'lease.json') } }

  prepare(requestInput: ReviewRequest): { request: ReviewRequest; reused: boolean } {
    const request = validateReviewRequest(requestInput)
    const p = this.paths(request.job_id); mkdirSync(p.dir, { recursive: true })
    if (existsSync(p.request)) {
      const prior = validateReviewRequest(json(p.request))
      if (!sameIdentity(prior, request)) throw new Error('job identity collision: job_id is already bound to another work item or SHA')
      return { request: prior, reused: this.readValidatedResult(prior) !== null }
    }
    writeFileSync(p.request, JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return { request, reused: false }
  }

  readValidatedResult(request: ReviewRequest): ReviewResult | null {
    const p = this.paths(request.job_id).result
    if (!existsSync(p)) return null
    try { return parseResultText(readFileSync(p, 'utf8'), request) } catch { return null }
  }

  acquireLease(request: ReviewRequest, ttlMs: number, holderId: string = randomUUID()): ReviewLease {
    const p = this.paths(request.job_id); mkdirSync(p.dir, { recursive: true })
    let priorAttempt = readdirSync(p.dir).flatMap(name => /^attempt-(\d+)\.json$/.exec(name)?.[1] ?? []).reduce((max, n) => Math.max(max, Number(n)), 0)
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
    writeFileSync(join(this.jobDir(meta.job_id), `attempt-${meta.attempt}.json`), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
  }

  releaseLease(lease: ReviewLease): void {
    const path = this.paths(lease.job_id).lease
    if (!existsSync(path)) return
    const current = json(path) as ReviewLease
    if (current.holder_id !== lease.holder_id) throw new Error('cannot release another lease holder')
    unlinkSync(path)
  }
}
