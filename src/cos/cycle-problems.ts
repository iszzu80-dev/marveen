/**
 * What counts as a PROBLEM in a cycle step's payload.
 *
 * Extracted from scripts/cos-cycle.ts on 2026-08-27, for the reason the file it
 * came from keeps proving: the runner is a top-level-await entry point that
 * spawns thirteen processes on import, so this logic was unreachable from a
 * test. `cos-cycle-report.test.ts` said so in its own header and re-implemented
 * the merge locally to get around it — a second definition of the thing under
 * test, which is the one that drifts.
 *
 * THREE DOORS INTO THE SAME ROOM, and the third is why this file exists.
 *
 *   2026-08-11  the channel step could not deliver an owner question, reported
 *               `{pending:1, sent:0, failures:[…]}`, exited 0 — and the cycle
 *               printed `problems: []`. Only `failed:true` was checked.
 *   2026-08-26  the reconcile step pretty-printed its JSON, nothing parsed, and
 *               the whole detection block sat inside `if (parsed)`. A real
 *               failure would have exited 0 and said nothing.
 *   2026-08-27  the progression step reports per-case errors under `errors` and
 *               a count under `cycleErrors`. Neither was read. Measured live
 *               during the P2 acceptance: `cycleErrors: 1`, one error in
 *               `errors`, and `problems: []` alongside it.
 *
 * The lesson each time is the same, so the rule here is stated once and applied
 * to every shape rather than to the shape that failed most recently: **a step
 * that says something went wrong must not be able to read as clean, whatever
 * word it uses to say it.**
 *
 * A COUNT WITHOUT DETAIL IS STILL A FAILURE. `cycleErrors: 3` with an empty
 * `errors` array is not "no problem" — it is a step that failed three times and
 * cannot say how. That reads as MORE alarming here, not less, because it is the
 * shape a truncated or partially-written payload takes.
 */

/** Names a step may use for "a list of things that went wrong". */
const FAILURE_LIST_KEYS = ['failures', 'errors'] as const
/** Names a step may use for "how many things went wrong". */
const FAILURE_COUNT_KEYS = ['cycleErrors', 'errorCount', 'failedCount'] as const

type Rec = Record<string, unknown>
const isRec = (o: unknown): o is Rec => !!o && typeof o === 'object' && !Array.isArray(o)

/** One entry of a failure list. Steps use two shapes: an object with a caseId
 *  and an error, or a bare string. Both are described, because a list that is
 *  rendered as `[object Object]` is a list nobody reads. */
function describeEntry(e: unknown): string {
  if (typeof e === 'string') return e
  if (isRec(e)) {
    const id = e.caseId ?? e.case_id ?? e.id ?? '?'
    const msg = e.error ?? e.reason ?? e.message ?? 'no error text'
    return `${String(id)}: ${String(msg)}`
  }
  return String(e)
}

function describeList(list: unknown[]): string {
  const rest = list.length > 1 ? ` (+${list.length - 1} more)` : ''
  return `${list.length} failed: ${describeEntry(list[0])}${rest}`
}

/** Problems visible in ONE object, without descending. */
function problemsIn(o: unknown): string[] {
  if (!isRec(o)) return []
  const out: string[] = []
  if (o.failed === true) out.push(String(o.error ?? o.reason ?? 'reported failed:true'))
  for (const key of FAILURE_LIST_KEYS) {
    const v = o[key]
    if (Array.isArray(v) && v.length > 0) out.push(describeList(v))
  }
  for (const key of FAILURE_COUNT_KEYS) {
    const v = o[key]
    if (typeof v === 'number' && v > 0) {
      // Only when no list already spoke for it: otherwise every real failure is
      // reported twice and the duplicate teaches the reader to skim.
      const listSpoke = FAILURE_LIST_KEYS.some(k => Array.isArray(o[k]) && (o[k] as unknown[]).length > 0)
      if (!listSpoke) out.push(`${key}: ${v}, but the payload carries no detail for them`)
    }
  }
  return out
}

/**
 * Every problem a step's merged payload reports, at the top level and one level
 * down.
 *
 * ONE LEVEL DOWN is not decoration: the progression runner reports its
 * subsystems under their own keys (`reader: {...}`) precisely so two subsystems'
 * counters cannot overwrite each other in the merge — and a top-level-only check
 * would then walk straight past `reader: {failed: true}`. The nesting that fixed
 * one silent failure would have created another directly below it.
 */
export function collectProblems(step: string, payload: unknown): string[] {
  if (!isRec(payload)) return []
  const out = problemsIn(payload).map(m => `${step}: ${m}`)
  for (const [key, value] of Object.entries(payload)) {
    out.push(...problemsIn(value).map(m => `${step}/${key}: ${m}`))
  }
  return out
}
