// The two activation blockers Istvan named on 2026-08-23, as executable rules.
//
// Each `it` below is one of the regressions he required verbatim. They are in
// one file on purpose: both blockers are about the same failure shape -- a gate
// that can be talked into green -- and splitting them would let one be dropped
// without the other looking incomplete.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  resolveRuntimeModelIdentity, validateCanonicalModelId, runtimeModelIdOrUnresolved,
  procfsReader, MODEL_IDENTITY_UNRESOLVED, CANONICAL_MODEL_ID_RE,
  type ProcSnapshot, type ProcReader,
} from '../cos/model-identity.js'
import {
  openProvenanceEpoch, evaluateProvenanceEpoch, sealProvenanceEpoch,
  activationProvenanceReadiness, activeProvenanceEpoch, listProvenanceEpochs,
  ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE,
} from '../cos/provenance-epoch.js'
import { recordTriageReceipt, goForwardProvenanceStatus } from '../cos/triage-provenance.js'

// ---------------------------------------------------------------------------
// Blocker #1 -- canonical runtime model identity
// ---------------------------------------------------------------------------

/** Build a fake process tree. Index 0 is the leaf; each entry's parent is the next. */
function treeReader(chain: Array<Partial<ProcSnapshot> & { comm: string; argv: string[] }>): ProcReader {
  const procs = new Map<number, ProcSnapshot>()
  chain.forEach((p, i) => {
    const pid = 1000 + i
    procs.set(pid, {
      pid, ppid: i + 1 < chain.length ? 1000 + i + 1 : 1,
      comm: p.comm, argv: p.argv, exe: p.exe ?? null,
    })
  })
  return (pid: number) => procs.get(pid) ?? null
}

const SHELL = { comm: 'bash', argv: ['/bin/bash', '-c', 'echo hi'] }
/** A real ESC byte, built rather than typed, so this source file itself stays
 *  free of the control characters it is about. */
const ESC = String.fromCharCode(27)

describe('blocker #1 -- canonical runtime model identity', () => {
  it('raw --model claude-opus-5 resolves to claude-opus-5 from raw argv', () => {
    const read = treeReader([
      SHELL,
      { comm: 'claude', argv: ['/home/iszzu/.local/bin/claude', '--continue', '--model', 'claude-opus-5'] },
    ])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.ok).toBe(true)
    expect(r.model).toBe('claude-opus-5')
    // The report must be able to SHOW where it came from, not merely claim it.
    expect(r.source?.path).toBe('/proc/1001/cmdline')
    expect(r.source?.argvIndex).toBe(2)
    expect(r.source?.form).toBe('separate')
    expect(runtimeModelIdOrUnresolved(r)).toBe('claude-opus-5')
  })

  it('accepts the --model=value form from raw argv too', () => {
    const read = treeReader([
      { comm: 'claude', argv: ['/usr/local/bin/claude', '--model=claude-sonnet-5'] },
    ])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.model).toBe('claude-sonnet-5')
    expect(r.source?.form).toBe('inline')
  })

  it('a decorated claude-opus-5[1m] FAILS and is NOT sanitized to claude-opus-5', () => {
    const read = treeReader([
      SHELL,
      { comm: 'claude', argv: ['/home/iszzu/.local/bin/claude', '--model', 'claude-opus-5[1m]'] },
    ])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.ok).toBe(false)
    expect(r.model).toBeNull()
    expect(r.reason).toBe('MODEL_IDENTITY_NOT_CANONICAL')
    // The exact anti-sanitization assertion: the raw value is preserved verbatim
    // and the stripped form never appears as an answer.
    expect(r.raw).toBe('claude-opus-5[1m]')
    expect(runtimeModelIdOrUnresolved(r)).toBe(MODEL_IDENTITY_UNRESOLVED)
  })

  it('a real ANSI SGR sequence FAILS as control characters, never stripped', () => {
    const decorated = ESC + '[1mclaude-opus-5' + ESC + '[0m'
    const read = treeReader([
      { comm: 'claude', argv: ['/home/iszzu/.local/bin/claude', '--model', decorated] },
    ])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('MODEL_IDENTITY_CONTROL_CHARACTERS')
    expect(r.raw).toBe(decorated)
    expect(r.model).toBeNull()
  })

  it('a decoy ancestor carrying --model is not accepted', () => {
    // A shell whose command line CONTAINS --model, above it the real claude with
    // a different model. The decoy is nearer; it must not win.
    const read = treeReader([
      { comm: 'bash', argv: ['/bin/bash', '-c', 'run --model claude-opus-5'] },
      { comm: 'claude', argv: ['/home/iszzu/.local/bin/claude', '--model', 'claude-sonnet-5'] },
    ])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.model).toBe('claude-sonnet-5')
    expect(r.walked[0]).toMatchObject({ comm: 'bash', isClaude: false })
  })

  it('a decoy named claude but launched as something else is not accepted', () => {
    // comm says claude, argv[0] does not: both must agree.
    const read = treeReader([
      { comm: 'claude', argv: ['/tmp/evil', '--model', 'attacker-model'] },
    ])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('MODEL_IDENTITY_UNRESOLVED')
    expect(r.raw).toBeNull()
  })

  it('an OUTER claude cannot supply the identity of an inner one that has no --model', () => {
    // The nearest claude is silent. Walking past it to a grandparent claude would
    // report a model this process was never launched with.
    const read = treeReader([
      { comm: 'claude', argv: ['/home/iszzu/.local/bin/claude', '--continue'] },
      { comm: 'claude', argv: ['/home/iszzu/.local/bin/claude', '--model', 'claude-opus-5'] },
    ])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('MODEL_IDENTITY_UNRESOLVED')
    expect(r.model).toBeNull()
  })

  it('no provable model at all yields MODEL_IDENTITY_UNRESOLVED', () => {
    const read = treeReader([SHELL, { comm: 'tmux: server', argv: ['/usr/bin/tmux', 'new-session'] }])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('MODEL_IDENTITY_UNRESOLVED')
    expect(runtimeModelIdOrUnresolved(r)).toBe(MODEL_IDENTITY_UNRESOLVED)
  })

  it('a trailing --model with no value is absent, not an empty model', () => {
    const read = treeReader([{ comm: 'claude', argv: ['/usr/bin/claude', '--model'] }])
    const r = resolveRuntimeModelIdentity(1000, read)
    expect(r.reason).toBe('MODEL_IDENTITY_UNRESOLVED')
    expect(r.model).toBeNull()
  })

  it('the canonical grammar admits real ids and rejects the shapes that hid the bug', () => {
    for (const good of [
      'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
      'deepseek-v4-pro', 'us.anthropic.claude-opus-5', 'anthropic/claude-opus-5',
    ]) {
      expect(CANONICAL_MODEL_ID_RE.test(good), good).toBe(true)
      expect(validateCanonicalModelId(good).ok, good).toBe(true)
    }
    for (const bad of [
      'claude-opus-5[1m]',      // the reported value
      'claude-opus-5 ',         // trailing space -- never trimmed away
      ' claude-opus-5',
      'claude-opus-5\n',        // a rendered line, not an argv value
      '', '-claude-opus-5', 'claude--opus-5', 'claude-opus-5/',
      'claude-opus-5;rm -rf /',
    ]) {
      expect(validateCanonicalModelId(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('a value longer than 128 chars is rejected rather than truncated', () => {
    const long = 'a'.repeat(129)
    const v = validateCanonicalModelId(long)
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toBe('MODEL_IDENTITY_NOT_CANONICAL')
  })

  it('the procfs reader reads NUL-separated argv, not a ps rendering', () => {
    // Drive it against THIS process: the point is that the reader works on the
    // real /proc, so the resolver is not only tested on fixtures.
    const read = procfsReader()
    const self = read(process.pid)
    expect(self).not.toBeNull()
    expect(self!.argv[0]).toContain('node')
    // A ps rendering would have joined argv with spaces into one string.
    expect(self!.argv.length).toBeGreaterThan(1)
    expect(self!.argv.some(a => a.includes('\0'))).toBe(false)
    expect(self!.ppid === null || self!.ppid > 0).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Blocker #2 -- cutoff semantics
// ---------------------------------------------------------------------------

describe('blocker #2 -- the activation cutoff is immutable', () => {
  let db: Database.Database
  const base = {
    accountId: 'private', messageId: 'm-complete', threadId: 't1',
    sourceManifestHash: 'src-hash', actionable: true, caseType: 'ADMIN',
    title: 'x', workspace: 'OPERATIONS', priority: 'P2', declaredSensitivity: 'LOW',
    actor: 'marveen', model: 'claude-opus-5', promptFingerprint: 'pf-1',
  }

  beforeEach(() => { db = new Database(':memory:') })

  it('the required regression: raising the cutoff cannot hide a post-cutoff failure', () => {
    // cutoff = 100, incomplete receipt decided at 150.
    const epoch = openProvenanceEpoch(db, { cutoff: 100, reason: 'stage 2G activation' }, 90)
    recordTriageReceipt(db, { ...base, messageId: 'incomplete', model: null }, 150)

    const first = evaluateProvenanceEpoch(db, epoch.epochId, 160)
    expect(first.status).toBe('GO_FORWARD_PROVENANCE_INCOMPLETE')
    expect(first.cutoff).toBe(100)
    expect(first.offenders[0].missing).toContain('model')

    // The raw function still shows WHY moving the cutoff would have worked: at
    // 200 the offending receipt is simply out of view. This is the escape hatch.
    expect(goForwardProvenanceStatus(db, 200).examined).toBe(0)
    expect(goForwardProvenanceStatus(db, 200).status).toBe('PASS')

    // And the epoch gate refuses to offer it. There is no argument to pass.
    expect(evaluateProvenanceEpoch(db, epoch.epochId, 170).cutoff).toBe(100)
    expect(evaluateProvenanceEpoch(db, epoch.epochId, 170).status)
      .toBe('GO_FORWARD_PROVENANCE_INCOMPLETE')
    expect(activationProvenanceReadiness(db, 170).status).toBe('GO_FORWARD_PROVENANCE_INCOMPLETE')
  })

  it('a second epoch at cutoff 200 does not turn the failed first epoch into PASS', () => {
    const e1 = openProvenanceEpoch(db, { cutoff: 100, reason: 'first activation' }, 90)
    recordTriageReceipt(db, { ...base, messageId: 'incomplete', model: null }, 150)
    evaluateProvenanceEpoch(db, e1.epochId, 160)
    const sealed = sealProvenanceEpoch(db, e1.epochId, 180)
    expect(sealed.sealedStatus).toBe('GO_FORWARD_PROVENANCE_INCOMPLETE')

    // New epoch, new id, new cutoff, clean receipts afterwards.
    const e2 = openProvenanceEpoch(db, { cutoff: 200, reason: 'provenance regime v2' }, 190)
    expect(e2.epochId).not.toBe(e1.epochId)
    recordTriageReceipt(db, { ...base, messageId: 'good' }, 250)
    expect(evaluateProvenanceEpoch(db, e2.epochId, 260).status).toBe('PASS')

    // e1 is still failed, and readiness still says so.
    const epochs = listProvenanceEpochs(db)
    expect(epochs[0].sealedStatus).toBe('GO_FORWARD_PROVENANCE_INCOMPLETE')
    expect(epochs[0].cutoff).toBe(100)
    const readiness = activationProvenanceReadiness(db, 260)
    expect(readiness.status).toBe('PRIOR_EPOCH_FAILED')
    expect(readiness.priorFailures.map(f => f.epochId)).toContain(e1.epochId)
  })

  it('a sealed epoch cannot be re-sealed, not even a failed one into a pass', () => {
    const e1 = openProvenanceEpoch(db, { cutoff: 100, reason: 'first' }, 90)
    recordTriageReceipt(db, { ...base, messageId: 'bad', model: null }, 150)
    evaluateProvenanceEpoch(db, e1.epochId, 160)
    sealProvenanceEpoch(db, e1.epochId, 180)
    expect(() => sealProvenanceEpoch(db, e1.epochId, 999))
      .toThrow(/PROVENANCE_EPOCH_ALREADY_SEALED/)
  })

  it('deleting the offending receipt does not buy a PASS seal', () => {
    // The scenario this guard exists for. Through the normal API an incomplete
    // receipt can never become complete -- recordTriageReceipt is append-only --
    // so the ONLY way a later reading turns clean is that someone reached past
    // the API and removed the evidence. The rollback plan forbids exactly that;
    // this makes the gate refuse to reward it. The seal takes the worst
    // observation ever recorded for the epoch, not the most recent one.
    const e1 = openProvenanceEpoch(db, { cutoff: 100, reason: 'first' }, 90)
    recordTriageReceipt(db, { ...base, messageId: 'bad', model: null }, 150)
    recordTriageReceipt(db, { ...base, messageId: 'good' }, 155)
    expect(evaluateProvenanceEpoch(db, e1.epochId, 160).status)
      .toBe('GO_FORWARD_PROVENANCE_INCOMPLETE')

    // A "repair" that deletes the offender. The live reading now says PASS...
    db.prepare("DELETE FROM cos_triage_provenance WHERE message_id='bad'").run()
    expect(evaluateProvenanceEpoch(db, e1.epochId, 170).status).toBe('PASS')

    // ...and the seal still says failed, because the failure was observed.
    const sealed = sealProvenanceEpoch(db, e1.epochId, 200)
    expect(sealed.sealedStatus).toBe('GO_FORWARD_PROVENANCE_INCOMPLETE')
    expect(sealed.sealedDetail).toMatch(/incomplete observation/)
    expect(activationProvenanceReadiness(db, 210).status).toBe('PRIOR_EPOCH_FAILED')
  })

  it('a new epoch may not start at or before the previous cutoff', () => {
    const e1 = openProvenanceEpoch(db, { cutoff: 100, reason: 'first' }, 90)
    recordTriageReceipt(db, { ...base, messageId: 'ok' }, 150)
    evaluateProvenanceEpoch(db, e1.epochId, 160)
    sealProvenanceEpoch(db, e1.epochId, 180)
    // Backward: would re-judge receipts the sealed epoch already judged.
    expect(() => openProvenanceEpoch(db, { cutoff: 100, reason: 'redo' }, 190))
      .toThrow(/PROVENANCE_EPOCH_CUTOFF_NOT_AFTER_PREVIOUS/)
    expect(() => openProvenanceEpoch(db, { cutoff: 50, reason: 'redo' }, 190))
      .toThrow(/PROVENANCE_EPOCH_CUTOFF_NOT_AFTER_PREVIOUS/)
  })

  it('two epochs cannot be open at once, so the gate never has a choice of cutoff', () => {
    openProvenanceEpoch(db, { cutoff: 100, reason: 'first' }, 90)
    expect(() => openProvenanceEpoch(db, { cutoff: 200, reason: 'second' }, 190))
      .toThrow(/PROVENANCE_EPOCH_ALREADY_OPEN/)
  })

  it('an activated epoch with zero post-cutoff receipts is AWAITING, not PASS', () => {
    const e = openProvenanceEpoch(db, { cutoff: 100, reason: 'activation' }, 90)
    // A receipt decided BEFORE the cutoff is history and must not count as evidence.
    recordTriageReceipt(db, { ...base, messageId: 'old' }, 50)
    const ev = evaluateProvenanceEpoch(db, e.epochId, 110)
    expect(ev.examined).toBe(0)
    expect(ev.status).toBe(ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE)
    expect(activationProvenanceReadiness(db, 110).status).toBe(ACTIVE_AWAITING_POST_CUTOFF_EVIDENCE)
    // And it cannot be sealed into a verdict nothing supports.
    expect(() => sealProvenanceEpoch(db, e.epochId, 120)).toThrow(/PROVENANCE_EPOCH_NO_EVIDENCE/)
  })

  it('PASS requires a real post-cutoff receipt, and says which epoch proved it', () => {
    const e = openProvenanceEpoch(db, { cutoff: 100, reason: 'activation' }, 90)
    recordTriageReceipt(db, { ...base, messageId: 'post' }, 150)
    const r = activationProvenanceReadiness(db, 160)
    expect(r.status).toBe('PASS')
    expect(r.activeEpoch?.epochId).toBe(e.epochId)
    expect(r.active?.examined).toBe(1)
    expect(r.priorFailures).toHaveLength(0)
    expect(activeProvenanceEpoch(db)?.cutoff).toBe(100)
  })

  it('an epoch needs a stated reason and a sane cutoff', () => {
    expect(() => openProvenanceEpoch(db, { cutoff: 100, reason: '  ' }, 90))
      .toThrow(/PROVENANCE_EPOCH_REASON_REQUIRED/)
    expect(() => openProvenanceEpoch(db, { cutoff: -1, reason: 'x' }, 90))
      .toThrow(/PROVENANCE_EPOCH_INVALID_CUTOFF/)
  })
})
