// The model-identity rule exists TWICE, and this is the test that keeps that safe.
//
// WHY TWICE AT ALL. The gate and the report need it in TypeScript
// (src/cos/model-identity.ts). The heartbeat needs it on its runtime path, which
// is the pinned release -- a directory that carries three stdlib Python/shell
// files and no node_modules. Pointing the heartbeat at a worktree path would
// reintroduce exactly the fragility `sync-scheduled-scripts.sh` was written to
// remove (card d3f9fd90: a branch switch elsewhere blinding a scheduled task).
// The alternative, restating the rules in the SKILL's prose, is worse: prose
// cannot be executed, so it drifts the first time either side is edited and
// nothing goes red.
//
// So the rule is implemented in both languages, and this test makes the SECOND
// copy cost something the moment it disagrees with the first. Two
// implementations without this test would be the "one standard, two homes"
// failure; with it, disagreement is a red build rather than a silent split.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { validateCanonicalModelId } from '../cos/model-identity.js'

const FEEDER = join(process.cwd(), 'scripts', 'email-triage-fetch.py')
const ESC = String.fromCharCode(27)

/** Every shape either implementation is expected to have an opinion about.
 *  Add here first when the rule changes; both sides then have to follow. */
const CASES: string[] = [
  'claude-opus-5',
  'claude-opus-5[1m]',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'deepseek-v4-pro',
  'us.anthropic.claude-opus-5',
  'anthropic/claude-opus-5',
  'claude-opus-5[1M]',
  'claude-opus-5[]',
  'claude-opus-5[1m',
  'claude-opus-5[1m]x',
  'claude[1m]-opus-5',
  'claude-opus-5]1m[',
  '[1m]',
  'claude-opus-5 ',
  ' claude-opus-5',
  'claude-opus-5\n',
  '',
  '-claude-opus-5',
  'claude--opus-5',
  'claude-opus-5/',
  'claude-opus-5;rm -rf /',
  ESC + '[1mclaude-opus-5' + ESC + '[0m',
  'claude-opus-5' + ESC + '[1m',
  'a'.repeat(129),
]

interface PyVerdict { ok: boolean; reason: string | null; modelId: string | null; model: string | null; modelVariant: string | null }

function pythonVerdicts(inputs: string[]): PyVerdict[] {
  // The driver imports the FEEDER ITSELF, so this exercises the file the pinned
  // release actually ships -- not a copy of its logic living in the test.
  const driver = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('feeder', ${JSON.stringify(FEEDER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out = []
for raw in json.loads(sys.stdin.read()):
    ok, payload, detail = m._validate_model_id(raw)
    if ok:
        out.append({'ok': True, 'reason': None, 'modelId': payload['modelId'],
                    'model': payload['model'], 'modelVariant': payload['modelVariant']})
    else:
        out.append({'ok': False, 'reason': payload, 'modelId': None,
                    'model': None, 'modelVariant': None})
print(json.dumps(out))
`
  const raw = execFileSync('python3', ['-c', driver], {
    input: JSON.stringify(inputs), encoding: 'utf8', timeout: 30_000,
  })
  return JSON.parse(raw) as PyVerdict[]
}

describe('model identity: the TypeScript and Python implementations must agree', () => {
  it('reaches the same verdict, reason and decomposition on every case', () => {
    const py = pythonVerdicts(CASES)
    expect(py).toHaveLength(CASES.length)

    const disagreements: string[] = []
    CASES.forEach((raw, i) => {
      const ts = validateCanonicalModelId(raw)
      const p = py[i]
      const tsView = ts.ok
        ? { ok: true, reason: null, modelId: ts.modelId, model: ts.model, modelVariant: ts.modelVariant }
        : { ok: false, reason: ts.reason, modelId: null, model: null, modelVariant: null }
      if (JSON.stringify(tsView) !== JSON.stringify(p)) {
        disagreements.push(
          `${JSON.stringify(raw)}\n    ts: ${JSON.stringify(tsView)}\n    py: ${JSON.stringify(p)}`)
      }
    })
    expect(disagreements.join('\n  '), 'the two implementations of the model-identity rule have drifted').toBe('')
  })

  it('both agree that the fleet launcher value decomposes the same way', () => {
    // The one case the whole activation hangs on, asserted explicitly so it can
    // never be lost inside the table above.
    const [p] = pythonVerdicts(['claude-opus-5[1m]'])
    const ts = validateCanonicalModelId('claude-opus-5[1m]')
    expect(ts.ok).toBe(true)
    expect(p.ok).toBe(true)
    expect(p.modelId).toBe('claude-opus-5[1m]')
    expect(p.model).toBe('claude-opus-5')
    expect(p.modelVariant).toBe('1m')
    expect(ts.ok && ts.modelId).toBe(p.modelId)
    expect(ts.ok && ts.model).toBe(p.model)
    expect(ts.ok && ts.modelVariant).toBe(p.modelVariant)
  })

  it('the Python side resolves a live identity from raw argv, or says it cannot', () => {
    // Not asserting a particular model: this box may run anything. Asserting the
    // SHAPE of the answer -- that it either proves an identity with a /proc
    // source, or reports the sentinel. A resolver that returned something else
    // (a default, a guess) would fail here.
    const driver = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('feeder', ${JSON.stringify(FEEDER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
r = m._resolve_runtime_model_identity()
print(json.dumps({'ok': r['ok'], 'triageModel': r['triageModel'],
                  'sourcePath': (r['source'] or {}).get('path'), 'walked': len(r['walked'])}))
`
    const r = JSON.parse(execFileSync('python3', ['-c', driver], { encoding: 'utf8', timeout: 30_000 }))
    expect(typeof r.ok).toBe('boolean')
    expect(r.walked).toBeGreaterThan(0)
    if (r.ok) {
      expect(validateCanonicalModelId(r.triageModel).ok).toBe(true)
      expect(r.sourcePath).toMatch(/^\/proc\/\d+\/cmdline$/)
    } else {
      expect(r.triageModel).toBe('MODEL_IDENTITY_UNRESOLVED')
    }
  })
})
