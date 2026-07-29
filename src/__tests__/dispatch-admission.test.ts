// P2-B: the WIRED admission gate (src/web/dispatch-admission.ts) -- the pure
// decision driven by real deployment-local config, plus the fail-open guard.
//
// These tests inject the saturation signals and a temp config path, so they
// exercise the real config loader and the real decision without a tmux server.
//
// Red-able: remove the refusal branch in decideDispatchAdmission -> "refuses a
// large card into a saturated session" goes red; remove the try/catch in
// evaluateDispatchAdmissionSafe -> "fails OPEN" goes red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateDispatchAdmission, evaluateDispatchAdmissionSafe } from '../web/dispatch-admission.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

let dir: string
let cfgPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p2b-admission-'))
  cfgPath = join(dir, 'session-efficiency.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeCfg(cfg: unknown) { writeFileSync(cfgPath, JSON.stringify(cfg)) }

const SATURATED = { pct: 0.94, paneSaturated: false }
const ROOMY = { pct: 0.20, paneSaturated: false }

const POLICY = {
  taskSizePolicy: { labels: { 'size:large': 'large', 'size:small': 'small' }, agentDefault: 'normal' },
}

describe('P2-B wired admission gate', () => {
  it('refuses a LARGE card (by label policy) into a saturated session', () => {
    writeCfg(POLICY)
    const out = evaluateDispatchAdmission({ agent: 'dev1', labels: ['size:large'] }, { signals: SATURATED, configPath: cfgPath })
    expect(out.admit).toBe(false)
    expect(out.refusalCode).toBe('large_into_saturated_session')
    expect(out.taskSize).toBe('large')
    expect(out.taskSizeSource).toBe('workflow_policy')
    expect(out.state).toBe('checkpoint_required')
    expect(out.checkpointAdvised).toBe(true)
    expect(out.measured).toBe(true)
    expect(out.faultedOpen).toBe(false)
  })

  it('admits the SAME large card into a session with room', () => {
    writeCfg(POLICY)
    const out = evaluateDispatchAdmission({ agent: 'dev1', labels: ['size:large'] }, { signals: ROOMY, configPath: cfgPath })
    expect(out.admit).toBe(true)
    expect(out.taskSize).toBe('large')
    expect(out.state).toBe('ok')
  })

  it('refuses on the always-on pane-saturation net alone, with no pct', () => {
    writeCfg(POLICY)
    const out = evaluateDispatchAdmission({ agent: 'dev1', explicitTaskSize: 'large' }, { signals: { pct: null, paneSaturated: true }, configPath: cfgPath })
    expect(out.admit).toBe(false)
    expect(out.state).toBe('hard_stop')
  })

  it('an UNMARKED card is admitted even into a saturated session (not treated as large)', () => {
    writeCfg(POLICY)
    const out = evaluateDispatchAdmission({ agent: 'dev1', labels: ['backend', 'refactor'] }, { signals: SATURATED, configPath: cfgPath })
    expect(out.admit).toBe(true)
    expect(out.taskSize).toBe('normal')
    expect(out.taskSizeSource).toBe('agent_default')
    // ...but the gate still reports that a checkpoint is due.
    expect(out.checkpointAdvised).toBe(true)
  })

  it('with the SHIPPED defaults (no config file at all) nothing is ever refused', () => {
    const noFile = join(dir, 'absent.json')
    for (const labels of [['size:large'], ['epic'], ['huge']]) {
      const out = evaluateDispatchAdmission({ agent: 'dev1', labels }, { signals: { pct: 0.99, paneSaturated: true }, configPath: noFile })
      expect(out.admit, labels.join(',')).toBe(true)
      expect(out.taskSize).toBe('normal')
    }
  })

  it('honours a per-agent threshold override', () => {
    writeCfg({ ...POLICY, agents: { dev1: { saturation: { warningPct: 0.3, noNewLargeTaskPct: 0.4 } } } })
    const mid = { pct: 0.45, paneSaturated: false }
    expect(evaluateDispatchAdmission({ agent: 'dev1', labels: ['size:large'] }, { signals: mid, configPath: cfgPath }).admit).toBe(false)
    // A different agent keeps the fleet thresholds and is unaffected.
    expect(evaluateDispatchAdmission({ agent: 'dev2', labels: ['size:large'] }, { signals: mid, configPath: cfgPath }).admit).toBe(true)
  })

  it('explicit dispatch metadata beats the label policy in both directions', () => {
    writeCfg(POLICY)
    expect(evaluateDispatchAdmission({ agent: 'dev1', labels: ['size:large'], explicitTaskSize: 'small' }, { signals: SATURATED, configPath: cfgPath }).admit).toBe(true)
    expect(evaluateDispatchAdmission({ agent: 'dev1', labels: ['size:small'], explicitTaskSize: 'large' }, { signals: SATURATED, configPath: cfgPath }).admit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FAULT ISOLATION: if this layer throws, the dispatch still goes out.
// ---------------------------------------------------------------------------
describe('P2-B admission gate: fault isolation', () => {
  it('fails OPEN when the signal source throws -- the dispatch proceeds', () => {
    writeCfg(POLICY)
    const boom = () => { throw new Error('tmux is on fire') }
    const out = evaluateDispatchAdmissionSafe(
      { agent: 'dev1', labels: ['size:large'] },
      { get signals() { return boom() as never }, configPath: cfgPath },
    )
    expect(out.admit).toBe(true)
    expect(out.faultedOpen).toBe(true)
    expect(out.reason).toMatch(/failing open/)
  })

  it('a corrupt config file degrades to defaults instead of refusing', () => {
    writeFileSync(cfgPath, '{ this is not json')
    const out = evaluateDispatchAdmissionSafe({ agent: 'dev1', labels: ['size:large'] }, { signals: { pct: 0.99, paneSaturated: true }, configPath: cfgPath })
    expect(out.admit).toBe(true)
  })

  it('the safe wrapper never throws for any shape of garbage input', () => {
    writeFileSync(cfgPath, JSON.stringify({ saturation: 'nonsense', taskSizePolicy: 42, agents: [] }))
    for (const req of [
      { agent: '' },
      { agent: 'dev1', labels: null as never },
      { agent: 'dev1', explicitTaskSize: 'gigantic' },
      { agent: 'dev1', labels: [undefined as never, 'size:large'] },
    ]) {
      expect(() => evaluateDispatchAdmissionSafe(req, { signals: SATURATED, configPath: cfgPath })).not.toThrow()
    }
  })
})

describe('P2-B admission gate: wired at the kanban origin', () => {
  const kanban = readFileSync(join(REPO_ROOT, 'src', 'web', 'routes', 'kanban.ts'), 'utf-8')

  it('fireKanbanDispatch consults the gate BEFORE queueing the message', () => {
    const gateAt = kanban.indexOf('evaluateDispatchAdmissionSafe({')
    const sendAt = kanban.indexOf('createAgentMessage(MAIN_AGENT_ID, target, content')
    expect(gateAt).toBeGreaterThan(-1)
    expect(sendAt).toBeGreaterThan(gateAt)
  })

  it('a refused card is NOT marked dispatched, so the work is deferred and not lost', () => {
    const block = kanban
      .slice(kanban.indexOf('if (!admission.admit)'), kanban.indexOf('const dispatchId = createDispatchSafe'))
      .replace(/^[ \t]*\/\/.*$/gm, '') // the comment explains the omission; assert on CODE
    expect(block).toMatch(/addKanbanComment/)
    expect(block).not.toMatch(/markKanbanCardDispatched/)
    expect(block).toMatch(/return/)
  })

  it('the origin uses the FAIL-OPEN wrapper, never the throwing one', () => {
    expect(kanban).toMatch(/evaluateDispatchAdmissionSafe/)
    expect(kanban).not.toMatch(/[^e]evaluateDispatchAdmission\(/)
  })

  it('the origin records packet metadata through the fault-isolated writer', () => {
    expect(kanban).toMatch(/recordPacketMetadataSafe\(getDb\(\), dispatchId/)
    expect(kanban).not.toMatch(/[^e]recordPacketMetadata\(/)
  })
})
