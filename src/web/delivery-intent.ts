// Delivery-intent registry: the authoritative record of what the message-router
// VERIFIABLY delivered into each tmux session from the queue. Stuck-input
// recovery consults it before ever re-submitting parked text, so the recovery
// can only re-submit content the SYSTEM ITSELF delivered -- never external,
// stale, or prior-re-inject text that merely happens to sit in the box.
//
// Context (2026-06-26 phantom prompt-injection): the recovery re-types + Enter-
// submits whatever looks parked in the input box. The dim ghost-suggestion seed
// is already closed (v1.15.0: env-disable at source + dim-strip at the
// detector). This gate is the PRINCIPLED, general layer on top: even a non-dim
// stray that slips into a box (persistence-injected, a stale fragment, a prior
// re-inject) is never auto-submitted unless it matches something the router
// just delivered there.
//
// Design constraint -- must not REGRESS delivery: a legit router delivery that
// fails to submit is exactly the stuck-input case the recovery exists to fix.
// So the matcher is truncation-tolerant (the box may show only part of a long
// delivery) and works within a generous freshness window; a no-match does NOT
// silently drop the message -- the caller redraws/clears and alerts once, so a
// genuinely-stuck-but-unmatched message surfaces instead of vanishing.

import { deliveryContentSignature } from '../pane-state.js'

interface DeliveryIntent {
  /** deliveryContentSignature() of the delivered content. */
  sig: string
  /** Queue message id that was delivered (for logging / correlation). */
  msgId: number | string
  /** When the router delivered it. */
  deliveredAt: number
}

// Freshness window: a parked delivery older than this is no longer eligible to
// auto-submit (a long-stale match is more likely coincidence than the live
// delivery). Generous so a slow recovery still matches its own delivery.
const MAX_AGE_MS = 5 * 60 * 1000
// Per-session ring cap: the last few deliveries cover overlapping in-flight
// messages without unbounded growth.
const MAX_PER_SESSION = 8
// Below this length a substring match is too easily coincidental, so require an
// exact match instead (a 2-3 char parked fragment must not match any delivery
// that merely contains it).
const MIN_SUBSTRING_LEN = 12

const registry = new Map<string, DeliveryIntent[]>()

// Record that the router delivered `content` to `session`. Call this ONLY at
// genuine delivery points (message-router, worker, scheduler) -- never from the
// recovery re-inject itself, or a prior re-inject would launder itself into
// "legit" and defeat the gate.
export function recordDelivery(
  session: string,
  content: string,
  msgId: number | string,
  now: number = Date.now(),
): void {
  const sig = deliveryContentSignature(content)
  if (sig.length === 0) return
  const list = (registry.get(session) ?? []).filter((d) => now - d.deliveredAt <= MAX_AGE_MS)
  list.push({ sig, msgId, deliveredAt: now })
  registry.set(session, list.slice(-MAX_PER_SESSION))
}

export interface DeliveryMatch {
  match: boolean
  msgId?: number | string
}

// Does `parkedSig` (parkedInputText() of the live box) correspond to a recent
// router delivery into `session`? Truncation-tolerant: a long delivery may show
// only a leading/trailing slice in the box, so a containment match either way
// counts -- but only above MIN_SUBSTRING_LEN, else an exact match is required.
export function matchDelivery(
  session: string,
  parkedSig: string,
  now: number = Date.now(),
): DeliveryMatch {
  const list = registry.get(session)
  if (!list || !parkedSig) return { match: false }
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i]
    if (now - d.deliveredAt > MAX_AGE_MS) continue
    if (d.sig === parkedSig) return { match: true, msgId: d.msgId }
    if (
      parkedSig.length >= MIN_SUBSTRING_LEN &&
      (d.sig.includes(parkedSig) || parkedSig.includes(d.sig))
    ) {
      return { match: true, msgId: d.msgId }
    }
  }
  return { match: false }
}

// Drop a session's records once its delivery is confirmed submitted (or the
// session is torn down), so a later identical-looking stray cannot match a
// long-since-handled delivery within the freshness window.
export function clearDeliveries(session: string): void {
  registry.delete(session)
}

// Test/diagnostic hook.
export function _deliveryRegistrySize(): number {
  return registry.size
}
