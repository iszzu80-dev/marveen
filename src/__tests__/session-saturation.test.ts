// P2-B: session saturation states, configurable thresholds, task-size
// resolution, and THE load-bearing admission rule (large refused into a
// saturated session).
//
// Two tests here are the gate's spine and are written to go RED under mutation:
//  - "refuses a large package into a saturated session" (delete the refusal
//    branch in decideDispatchAdmission -> red)
//  - "an unmarked task is NOT treated as large" (make the default 'large' -> red)

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  classifySaturation,
  normalizeSaturationThresholds,
  resolveTaskSize,
  normalizeTaskSizePolicy,
  decideDispatchAdmission,
  atOrAbove,
  saturationSeverity,
  DEFAULT_SATURATION_THRESHOLDS,
  DEFAULT_TASK_SIZE_POLICY,
  LARGE_TASK_REFUSAL_FLOOR,
  SATURATION_ORDER,
  type SaturationThresholds,
  type SaturationState,
  type TaskSize,
} from '../session-saturation.js'
import { DEFAULT_CONTEXT_GUARD, decideGuard, INITIAL_GUARD_STATE, normalizeContextGuardConfig } from '../context-guard.js'
import { normalizeSessionEfficiencyConfig } from '../web/session-efficiency-store.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

const T = DEFAULT_SATURATION_THRESHOLDS
function state(pct: number | null, paneSaturated = false, th: SaturationThresholds = T): SaturationState {
  return classifySaturation({ pct, paneSaturated }, th).state
}

describe('P2-B saturation: all four required states exist and are reachable', () => {
  it('classifies ok / warning / no_new_large_task / checkpoint_required / hard_stop', () => {
    expect(state(0.10)).toBe('ok')
    expect(state(T.warningPct)).toBe('warning')
    expect(state(T.noNewLargeTaskPct)).toBe('no_new_large_task')
    expect(state(T.checkpointRequiredPct)).toBe('checkpoint_required')
    expect(state(T.hardStopPct)).toBe('hard_stop')
    expect(state(1.20)).toBe('hard_stop')
  })

  it('each tier fires exactly at its boundary, not one step below', () => {
    expect(state(T.warningPct - 0.0001)).toBe('ok')
    expect(state(T.noNewLargeTaskPct - 0.0001)).toBe('warning')
    expect(state(T.checkpointRequiredPct - 0.0001)).toBe('no_new_large_task')
    expect(state(T.hardStopPct - 0.0001)).toBe('checkpoint_required')
  })

  it('every one of the four new states is produced by SOME input (no dead state)', () => {
    const produced = new Set<SaturationState>()
    for (let pct = 0; pct <= 1.2; pct += 0.005) produced.add(state(Number(pct.toFixed(3))))
    for (const s of ['warning', 'no_new_large_task', 'checkpoint_required', 'hard_stop'] as SaturationState[]) {
      expect(produced.has(s), s).toBe(true)
    }
    expect(SATURATION_ORDER).toEqual(['ok', 'warning', 'no_new_large_task', 'checkpoint_required', 'hard_stop'])
    expect(saturationSeverity('hard_stop')).toBeGreaterThan(saturationSeverity('warning'))
    expect(atOrAbove('checkpoint_required', 'no_new_large_task')).toBe(true)
    expect(atOrAbove('warning', 'no_new_large_task')).toBe(false)
  })

  it('mirrors the live ALWAYS-ON pane-saturation net: a saturated pane is hard_stop with no pct at all', () => {
    expect(state(null, true)).toBe('hard_stop')
    expect(state(0.05, true)).toBe('hard_stop')
    // ...and only an explicit false disarms it, exactly like saturationRestart.
    const disarmed = normalizeSaturationThresholds({ paneSaturationIsHardStop: false })
    expect(state(0.05, true, disarmed)).toBe('ok')
    expect(normalizeSaturationThresholds({}).paneSaturationIsHardStop).toBe(true)
    expect(normalizeSaturationThresholds({ paneSaturationIsHardStop: 'no' }).paneSaturationIsHardStop).toBe(true)
  })

  it('an UNMEASURABLE session fails OPEN (ok + measured=false), never into a refusal', () => {
    const c = classifySaturation({ pct: null, paneSaturated: false })
    expect(c.state).toBe('ok')
    expect(c.measured).toBe(false)
    expect(c.reason).toMatch(/unmeasurable/)
    // NaN / Infinity are treated as unmeasurable too, not as 0 or as huge.
    expect(classifySaturation({ pct: Number.NaN }).measured).toBe(false)
    expect(classifySaturation({ pct: Number.POSITIVE_INFINITY }).measured).toBe(false)
  })
})

describe('P2-B saturation: defaults are behaviour-neutral vs the LIVE context guard', () => {
  it('checkpointRequiredPct == live actPct and hardStopPct == live hardPct', () => {
    // This is the guard against a future edit "restoring" the older 85/90/92/97
    // tiers the superseded audit implies. The live numbers are 0.90 / 0.97.
    expect(DEFAULT_CONTEXT_GUARD.actPct).toBe(0.90)
    expect(DEFAULT_CONTEXT_GUARD.hardPct).toBe(0.97)
    expect(T.checkpointRequiredPct).toBe(DEFAULT_CONTEXT_GUARD.actPct)
    expect(T.hardStopPct).toBe(DEFAULT_CONTEXT_GUARD.hardPct)
    expect(T.paneSaturationIsHardStop).toBe(DEFAULT_CONTEXT_GUARD.saturationRestart)
  })

  it('the two ADDITIVE tiers sit strictly below the live ones', () => {
    expect(T.warningPct).toBeLessThan(T.noNewLargeTaskPct)
    expect(T.noNewLargeTaskPct).toBeLessThan(T.checkpointRequiredPct)
  })

  it('decideGuard is untouched: the live guard still acts at 0.90 / 0.97 exactly', () => {
    const cfg = normalizeContextGuardConfig({ enabled: true })
    const base = { nowMs: 1_000_000, running: true, paneIdle: true, paneBusy: false, sessionReady: false, handoffMtime: null, paneSaturated: false }
    expect(decideGuard(INITIAL_GUARD_STATE, { ...base, pct: 0.89 }, cfg).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, { ...base, pct: 0.90 }, cfg).action).toBe('request-handoff')
    expect(decideGuard(INITIAL_GUARD_STATE, { ...base, pct: 0.97 }, cfg).action).toBe('restart')
  })

  it('the DEFAULT task-size policy can never produce `large`, so nothing is refused out of the box', () => {
    expect(DEFAULT_TASK_SIZE_POLICY.agentDefault).toBe('normal')
    expect(DEFAULT_TASK_SIZE_POLICY.labels).toEqual({})
    expect(DEFAULT_TASK_SIZE_POLICY.cardTypes).toEqual({})
    const r = resolveTaskSize({ labels: ['epic', 'size:large', 'urgent'], cardType: 'epic' })
    expect(r.taskSize).toBe('normal')
    expect(r.source).toBe('agent_default')
  })
})

describe('P2-B saturation: thresholds are configurable', () => {
  it('accepts operator values and falls back per-field on garbage', () => {
    const th = normalizeSaturationThresholds({ warningPct: 0.5, noNewLargeTaskPct: 0.6, checkpointRequiredPct: 0.7, hardStopPct: 0.8 })
    expect(th).toMatchObject({ warningPct: 0.5, noNewLargeTaskPct: 0.6, checkpointRequiredPct: 0.7, hardStopPct: 0.8 })
    expect(state(0.65, false, th)).toBe('no_new_large_task')
    const junk = normalizeSaturationThresholds({ warningPct: 'x', noNewLargeTaskPct: -1, checkpointRequiredPct: 5, hardStopPct: null })
    expect(junk).toMatchObject({
      warningPct: T.warningPct, noNewLargeTaskPct: T.noNewLargeTaskPct,
      checkpointRequiredPct: T.checkpointRequiredPct, hardStopPct: T.hardStopPct,
    })
  })

  it('forces the tiers non-decreasing so hard_stop can never be unreachable', () => {
    const th = normalizeSaturationThresholds({ warningPct: 0.9, noNewLargeTaskPct: 0.5, checkpointRequiredPct: 0.4, hardStopPct: 0.3 })
    expect(th.noNewLargeTaskPct).toBeGreaterThanOrEqual(th.warningPct)
    expect(th.checkpointRequiredPct).toBeGreaterThanOrEqual(th.noNewLargeTaskPct)
    expect(th.hardStopPct).toBeGreaterThanOrEqual(th.checkpointRequiredPct)
    expect(state(0.99, false, th)).toBe('hard_stop')
  })

  it('the committed config example parses into exactly the documented values', () => {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'config-examples', 'session-efficiency.example.json'), 'utf-8'))
    const cfg = normalizeSessionEfficiencyConfig(raw)
    expect(cfg.saturation).toMatchObject({
      warningPct: 0.8, noNewLargeTaskPct: 0.85, checkpointRequiredPct: 0.9, hardStopPct: 0.97, paneSaturationIsHardStop: true,
    })
    expect(cfg.taskSizePolicy.labels['size:large']).toBe('large')
    expect(cfg.taskSizePolicy.agentDefault).toBe('normal')
    // A per-agent block that overrides only the lower tiers inherits the FLEET rest.
    expect(cfg.agents['example-agent'].saturation.warningPct).toBe(0.7)
    expect(cfg.agents['example-agent'].saturation.noNewLargeTaskPct).toBe(0.75)
    expect(cfg.agents['example-agent'].saturation.checkpointRequiredPct).toBe(0.9)
    expect(cfg.agents['example-agent'].saturation.hardStopPct).toBe(0.97)
  })

  it('a missing/empty config yields the behaviour-neutral defaults', () => {
    const cfg = normalizeSessionEfficiencyConfig(undefined)
    expect(cfg.saturation).toEqual(DEFAULT_SATURATION_THRESHOLDS)
    expect(cfg.taskSizePolicy).toEqual(DEFAULT_TASK_SIZE_POLICY)
    expect(cfg.agents).toEqual({})
  })
})

describe('P2-B task size: explicit metadata or deterministic workflow policy, NEVER a guess', () => {
  const policy = normalizeTaskSizePolicy({
    labels: { 'size:large': 'large', 'size:small': 'small', epic: 'large' },
    cardTypes: { chore: 'small', epic: 'large' },
    agentDefault: 'normal',
  })

  it('explicit dispatch metadata wins over everything', () => {
    const r = resolveTaskSize({ explicit: 'small', labels: ['size:large'], cardType: 'epic' }, policy)
    expect(r.taskSize).toBe('small')
    expect(r.source).toBe('explicit')
  })

  it('workflow policy resolves from a kanban label, then a card type', () => {
    expect(resolveTaskSize({ labels: ['size:large'] }, policy)).toMatchObject({ taskSize: 'large', source: 'workflow_policy' })
    expect(resolveTaskSize({ labels: ['unrelated'], cardType: 'chore' }, policy)).toMatchObject({ taskSize: 'small', source: 'workflow_policy' })
    expect(resolveTaskSize({ labels: ['SIZE:Large'] }, policy).taskSize).toBe('large') // case-insensitive
  })

  it('conflicting labels resolve to the MOST severe (refusing is cheaper than admitting)', () => {
    expect(resolveTaskSize({ labels: ['size:small', 'size:large'] }, policy).taskSize).toBe('large')
  })

  // --- red-able: flip DEFAULT_TASK_SIZE_POLICY.agentDefault to 'large' -> red
  it('an UNMARKED task is NOT treated as large -- it takes the agent default', () => {
    const r = resolveTaskSize({}, policy)
    expect(r.taskSize).toBe('normal')
    expect(r.taskSize).not.toBe('large')
    expect(r.source).toBe('agent_default')
    expect(r.reason).toMatch(/unmarked/)
    // An unrecognised label is NOT a hint: it contributes nothing.
    expect(resolveTaskSize({ labels: ['refactor', 'backend', 'huge-and-scary'] }, policy).taskSize).toBe('normal')
    // An unknown/garbage explicit value is dropped, never upgraded to large.
    expect(resolveTaskSize({ explicit: 'enormous' }, policy).taskSize).toBe('normal')
    expect(resolveTaskSize({ explicit: null }, policy).taskSize).toBe('normal')
  })

  it('a per-agent default is honoured, and an invalid policy size is dropped not upgraded', () => {
    expect(resolveTaskSize({ agentDefault: 'small' }, policy).taskSize).toBe('small')
    const junk = normalizeTaskSizePolicy({ labels: { a: 'huge', b: 'large' }, agentDefault: 'gigantic' })
    expect(junk.labels).toEqual({ b: 'large' })
    expect(junk.agentDefault).toBe('normal')
  })
})

describe('P2-B admission: THE load-bearing rule', () => {
  const sat = (pct: number | null, paneSaturated = false) => classifySaturation({ pct, paneSaturated })

  // --- red-able: delete the refusal branch in decideDispatchAdmission -> red
  it('REFUSES a large work package into a saturated session', () => {
    for (const pct of [T.noNewLargeTaskPct, T.checkpointRequiredPct, T.hardStopPct, 1.05]) {
      const d = decideDispatchAdmission({ taskSize: 'large', saturation: sat(pct) })
      expect(d.admit, `pct=${pct}`).toBe(false)
      expect(d.refusalCode).toBe('large_into_saturated_session')
      expect(d.reason).toMatch(/large work package refused/)
    }
    // The always-on pane net alone is enough, with no pct at all.
    const d = decideDispatchAdmission({ taskSize: 'large', saturation: sat(null, true) })
    expect(d.admit).toBe(false)
    expect(d.state).toBe('hard_stop')
  })

  it('the refusal floor is the configured threshold, not a hardcoded number', () => {
    expect(LARGE_TASK_REFUSAL_FLOOR).toBe('no_new_large_task')
    const strict = normalizeSaturationThresholds({ warningPct: 0.2, noNewLargeTaskPct: 0.3, checkpointRequiredPct: 0.9, hardStopPct: 0.97 })
    // At 35% a large task is refused under the strict config and admitted under
    // the default one -- i.e. the threshold really is what decides.
    expect(decideDispatchAdmission({ taskSize: 'large', saturation: classifySaturation({ pct: 0.35 }, strict) }).admit).toBe(false)
    expect(decideDispatchAdmission({ taskSize: 'large', saturation: classifySaturation({ pct: 0.35 }, T) }).admit).toBe(true)
  })

  it('ADMITS a large package into a session with room', () => {
    for (const pct of [0, 0.5, T.warningPct, T.noNewLargeTaskPct - 0.0001]) {
      expect(decideDispatchAdmission({ taskSize: 'large', saturation: sat(pct) }).admit, `pct=${pct}`).toBe(true)
    }
  })

  it('never refuses small or normal -- every dispatch that works today still works', () => {
    for (const size of ['small', 'normal'] as TaskSize[]) {
      for (const pct of [0, 0.85, 0.9, 0.97, 1.3]) {
        expect(decideDispatchAdmission({ taskSize: size, saturation: sat(pct) }).admit, `${size}@${pct}`).toBe(true)
      }
      expect(decideDispatchAdmission({ taskSize: size, saturation: sat(null, true) }).admit).toBe(true)
    }
  })

  it('an unmeasurable session admits everything, including large', () => {
    expect(decideDispatchAdmission({ taskSize: 'large', saturation: sat(null) }).admit).toBe(true)
  })

  it('reports checkpointAdvised at/above checkpoint_required, independently of admit', () => {
    expect(decideDispatchAdmission({ taskSize: 'normal', saturation: sat(T.checkpointRequiredPct) }).checkpointAdvised).toBe(true)
    expect(decideDispatchAdmission({ taskSize: 'normal', saturation: sat(T.noNewLargeTaskPct) }).checkpointAdvised).toBe(false)
    expect(decideDispatchAdmission({ taskSize: 'large', saturation: sat(T.hardStopPct) }).checkpointAdvised).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// No LLM on the packet / taskSize decision paths. Static, transitive: walk the
// import closure of the decision modules and assert nothing in it can reach a
// model. Adding `import { runAgent } from '../agent.js'` to any of them -> red.
// ---------------------------------------------------------------------------
describe('P2-B: no model invocation on the packet / taskSize decision paths', () => {
  const SRC = join(REPO_ROOT, 'src')

  function resolveImport(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null
    const base = join(dirname(fromFile), spec.replace(/\.js$/, ''))
    for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand
    }
    return null
  }

  function closure(entries: string[]): { files: string[]; bareSpecs: Set<string> } {
    const seen = new Set<string>()
    const bareSpecs = new Set<string>()
    const queue = [...entries]
    while (queue.length) {
      const f = queue.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      const src = readFileSync(f, 'utf-8')
      for (const m of src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1]
        if (!spec.startsWith('.')) { bareSpecs.add(spec); continue }
        const resolved = resolveImport(f, spec)
        if (resolved) queue.push(resolved)
      }
    }
    return { files: [...seen], bareSpecs }
  }

  const ENTRIES = [
    join(SRC, 'context-packet.ts'),
    join(SRC, 'context-packet-example.ts'),
    join(SRC, 'session-saturation.ts'),
    join(SRC, 'session-checkpoint.ts'),
    join(SRC, 'costops', 'packet-metadata.ts'),
    join(SRC, 'web', 'session-efficiency-store.ts'),
  ]

  it('the transitive import closure reaches no model client and no agent runner', () => {
    const { files, bareSpecs } = closure(ENTRIES)
    expect(files.length).toBeGreaterThanOrEqual(ENTRIES.length)
    for (const spec of bareSpecs) {
      expect(spec, `bare import in the packet/taskSize closure: ${spec}`).not.toMatch(/anthropic|openai|claude-agent-sdk|deepseek/i)
    }
    for (const f of files) {
      expect(f, 'agent runner must not be in the closure').not.toMatch(/[/\\](agent|llm-[a-z-]+)\.ts$/)
    }
  })

  it('no decision module spawns a model process or calls a model helper', () => {
    for (const f of closure(ENTRIES).files) {
      const src = readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      expect(src, f).not.toMatch(/\brunAgent\s*\(/)
      expect(src, f).not.toMatch(/\bquery\s*\(\s*\{[\s\S]{0,80}prompt\s*:/)
      expect(src, f).not.toMatch(/(spawn|exec|execFile)(Sync)?\s*\(\s*['"`]claude['"`]/)
      expect(src, f).not.toMatch(/messages\.create\s*\(/)
    }
  })

  it('the whole src/ tree has no module named like a packet-size or task-size estimator model call', () => {
    // Cheap structural guard: if someone later adds an LLM sizing helper, it will
    // almost certainly land next to these files under a name like this.
    const names = readdirSync(SRC)
    for (const n of names) expect(n).not.toMatch(/llm.*(packet|task-?size)|(packet|task-?size).*llm/i)
  })
})
