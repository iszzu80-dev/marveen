// §11.2 A: fairness between the two domains, as a dependency-free helper.
//
// EXTRACTED, NOT COPIED. This function lived in `reader-cycle.ts` and was used
// by the Reader and goal-enrichment sweeps. The v1.4 proactive sweep needs the
// same rule — and `reader-cycle.ts` imports the Reader, which imports the model
// client, which is on the §15.3 forbidden list. Importing it from `proactive/`
// would have put an HTTP client into the v1.4 dependency closure and failed the
// release-boundary standing check.
//
// Two ways out of that, and only one of them is honest: copy the eight lines
// into the proactive module, or move them somewhere both can reach. A copy would
// be two fairness policies that agree today — and the fairness rule is the kind
// that gets tuned, so they would agree until the day one of them was tuned.
//
// This file imports nothing. That is the point.

/**
 * Take `limit` items, one domain at a time, in turn.
 *
 * The sweeps used to enumerate `personal` in full and then `zst`, then
 * `slice(0, limit)`. With a limit of three to five per cycle and any personal
 * backlog at all, the corporate half of the store was never reached — not
 * "later", never, because the backlog is refilled by the same sweeps. Order
 * WITHIN a domain is preserved (it carries the domain's own priority); only the
 * interleaving is added.
 *
 * `limit <= 0` means no bound, which is how a caller asks "how many are there in
 * total" without a second query.
 */
export function roundRobinByDomain<T extends { domain: string }>(items: T[], limit: number): T[] {
  const queues = new Map<string, T[]>()
  for (const i of items) {
    const q = queues.get(i.domain)
    if (q) q.push(i); else queues.set(i.domain, [i])
  }
  const out: T[] = []
  const lists = [...queues.values()]
  for (let round = 0; lists.some(l => round < l.length); round++) {
    for (const l of lists) {
      if (round >= l.length) continue
      out.push(l[round])
      if (limit > 0 && out.length >= limit) return out
    }
  }
  return out
}

/**
 * §11.2 A / §11.3 `starvation_detected`: did the bound leave one domain with
 * nothing while another got work?
 *
 * Starvation is not "one domain got fewer". Interleaving guarantees a fair split
 * of what fits, and an odd budget has to go somewhere. Starvation is a domain
 * that HAD candidates and received ZERO — the state the round-robin exists to
 * make impossible, and therefore the one worth an alarm rather than a ratio.
 */
export function starvedDomains<T extends { domain: string }>(
  all: T[], taken: T[],
): string[] {
  const had = new Set(all.map(i => i.domain))
  const got = new Set(taken.map(i => i.domain))
  return [...had].filter(d => !got.has(d)).sort()
}
