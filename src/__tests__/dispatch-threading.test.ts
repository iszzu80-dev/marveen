import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// P2-A: prove every dispatch origin (a-e) creates a dispatch_id and threads it
// through to the single funnel sendPromptToSession(opts.dispatchId). The actual
// send is tmux-driven (not unit-runnable), so this asserts the wiring at the
// source level. The runtime DB behaviour is covered in costops-dispatch.test.ts.

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf-8')
const AGENT_PROCESS = read('../web/agent-process.ts')
const KANBAN = read('../web/routes/kanban.ts')
const ROUTER = read('../web/message-router.ts')
const SCHEDULE = read('../web/schedule-runner.ts')
const WORKER = read('../web/agent-worker.ts')
const DB = read('../db.ts')
const COSTOPS_SCHEMA = read('../costops/schema.ts')

describe('P2-A: sendPromptToSession is the threaded funnel', () => {
  it('accepts an optional dispatchId in its opts bag', () => {
    const sigIdx = AGENT_PROCESS.indexOf('export async function sendPromptToSession(')
    expect(sigIdx).toBeGreaterThan(0)
    const sig = AGENT_PROCESS.slice(sigIdx, sigIdx + 400)
    expect(sig).toMatch(/dispatchId\?:\s*string\s*\|\s*null/)
  })

  it('emits a delivery receipt but does NOT write to the DB (measurement-only, cannot block the send)', () => {
    expect(AGENT_PROCESS).toMatch(/if \(opts\.dispatchId\)/)
    expect(AGENT_PROCESS).toMatch(/delivering instrumented dispatch/)
    // agent-process.ts must NOT import the db / dispatch module -- the write
    // path stays at the origins, so a measurement bug can never break a send.
    expect(AGENT_PROCESS).not.toMatch(/from '\.\.\/db\.js'/)
    expect(AGENT_PROCESS).not.toMatch(/costops\/dispatch/)
  })
})

describe('P2-A origin (a) kanban', () => {
  it('creates a kanban-source dispatch and threads it onto the queued message', () => {
    expect(KANBAN).toMatch(/createDispatchSafe\(getDb\(\), \{\s*source: 'kanban'/)
    // dispatchId is passed as the 6th arg of createAgentMessage (after traceCtx).
    expect(KANBAN).toMatch(/createAgentMessage\(MAIN_AGENT_ID, target, content, null, null, dispatchId\)/)
  })
  it('records the accepted outcome on kanban status->done', () => {
    expect(KANBAN).toMatch(/if \(status === 'done'\)/)
    expect(KANBAN).toMatch(/recordAcceptedOutcomeForCard\(getDb\(\), id\)/)
  })
})

describe('P2-A origin (b) inter-agent router', () => {
  it('creates a message-source dispatch when none is carried, then threads it to the funnel', () => {
    expect(ROUTER).toMatch(/createDispatchSafe\(getDb\(\), \{ source: 'message', agent: msg\.to_agent \}\)/)
    expect(ROUTER).toMatch(/let dispatchId = msg\.dispatch_id/)
    expect(ROUTER).toMatch(/sendPromptToSession\(session, prefix \+ wrapped, host, \{ dispatchId \}\)/)
  })
  it('does not instrument channel-inbound (user) messages -- documented threshold', () => {
    expect(ROUTER).toMatch(/if \(!dispatchId && !isChannelInbound\)/)
  })
})

describe('P2-A origin (c) scheduler + (e) reinject', () => {
  it('creates a scheduler-source dispatch with task_type and threads it', () => {
    expect(SCHEDULE).toMatch(/createDispatchSafe\(getDb\(\), \{\s*source: 'scheduler', agent: agentName, taskType: task\.type/)
    expect(SCHEDULE).toMatch(/sendPromptToSession\(session, fullPrompt, host, \{ waitForIdle: !task\.forceSend, dispatchId \}\)/)
  })
  it('reuses the SAME dispatchId on a swallowed-Enter reinjection (not a new work-package)', () => {
    expect(SCHEDULE).toMatch(/sendPromptToSession\(session, fullPrompt, host, \{ waitForIdle: false, dispatchId \}\)/)
  })
})

describe('P2-A origin (d) worker', () => {
  it('creates a worker-source dispatch and threads it to the funnel', () => {
    expect(WORKER).toMatch(/createDispatchSafe\(getDb\(\), \{ source: 'worker', agent: MAIN_AGENT_ID, taskType: 'worker' \}\)/)
    expect(WORKER).toMatch(/sendPromptToSession\(ctx\.session, buildWorkerPrompt\(message, outPath, donePath\), null, \{ dispatchId \}\)/)
  })
})

describe('P2-A db wiring', () => {
  it('agent_messages gains a nullable dispatch_id column via idempotent ALTER', () => {
    expect(DB).toMatch(/ALTER TABLE agent_messages ADD COLUMN dispatch_id TEXT/)
  })
  it('createAgentMessage carries dispatchId into the insert', () => {
    expect(DB).toMatch(/dispatchId\?:\s*string\s*\|\s*null/)
    expect(DB).toMatch(/dispatch_id\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/)
  })
  it('the P2-A dispatch schema is installed through the CostOps seam, NOT a parallel init', () => {
    // The seam rule: db.ts owns exactly one CostOps call (initCostOpsSchema);
    // dispatch DDL rides that seam so it survives upstream merges.
    expect(COSTOPS_SCHEMA).toMatch(/import \{ initDispatchSchema \} from '\.\/dispatch\.js'/)
    expect(COSTOPS_SCHEMA).toMatch(/initDispatchSchema\(db\)/)
    // db.ts must NOT install it as a separate seam.
    expect(DB).not.toMatch(/initDispatchSchema/)
  })
})
