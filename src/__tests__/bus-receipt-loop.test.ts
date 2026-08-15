import { describe, it, expect } from 'vitest'
import { isNoticeNotWork } from '../web/routes/messages.js'

// 2026-08-15, measured on the live bus. Marking a `[handoff-failure]` message
// done produced a receipt addressed to `system` — a pseudo-agent that is never a
// tmux session — which could not be delivered, which produced the NEXT
// handoff-failure. One new message per retry window, indefinitely:
//
//   21086 (digest)  -> mark done -> 21088 [Eredmény] -> undeliverable
//   21089 [handoff-failure] -> mark done -> 21090 [Eredmény] -> undeliverable
//   21091 [handoff-failure] -> ... and so on, roughly hourly
//
// The old guard skipped only `[Eredmény]`, so every failure notice re-armed it.

describe('a receipt is not sent for a notice that is not work', () => {
  it('skips a completion report — it is already the answer', () => {
    expect(isNoticeNotWork('[Eredmény] msg_id:21086 status:done\n\nkesz')).toBe(true)
  })

  // The case that closed the loop.
  it('skips a delivery failure — it comes from `system`, which cannot receive one', () => {
    expect(isNoticeNotWork(
      '[handoff-failure] Inter-agent message (id 21090) marveen -> system could NOT be delivered'
    )).toBe(true)
  })

  // POSITIVE CONTROL: a guard that answers true to everything would pass both
  // tests above while silencing every real receipt.
  it('does NOT skip a real task message', () => {
    expect(isNoticeNotWork('Kerlek nezd meg a 00851235 kartyat es jelezz vissza.')).toBe(false)
  })

  it('does NOT skip a message that merely MENTIONS a failure later on', () => {
    expect(isNoticeNotWork(
      'A build elszallt, lasd a [handoff-failure] uzenetet is — kerem a valaszod.'
    )).toBe(false)
  })

  it('matches on the prefix only, so an owner question keeps its receipt', () => {
    expect(isNoticeNotWork('❓ NAV Adozoi rendelkezes — atvetel kell')).toBe(false)
  })
})

// ── THE SECOND DOOR ──────────────────────────────────────────────────────
//
// Same afternoon, same bug, different exit. The guard above stops a receipt for
// a message that IS a notice. It does not stop a receipt addressed to a sender
// that can never receive one.
//
// Measured on the live bus after the daily radar digest went in:
//   21092 (digest, from cos-radar) -> mark done -> 21093 [Eredmény] -> cos-radar
//   21093 failed the full retry window            -> 21094 [handoff-failure]
//   21094 produced nothing further                -> the first guard held
//
// So: not a loop, but guaranteed noise once a day, for ever, with the same
// structural cause — an addressee that cannot answer. `cos-radar`, `cos-outbound`
// and `system` are producers, not fleet agents; they have no session by
// construction, so their receipt's failure is a certainty, not an accident.
//
// The predicate is DERIVED (isKnownAgent, the same one the POST handler uses to
// reject unregistered senders), not a hand-maintained list of pseudo-agents —
// otherwise the next producer is covered the day someone remembers it.
import { shouldSendReceipt } from '../web/routes/messages.js'
import { isKnownAgent } from '../web/agent-config.js'

// The RULE is under test, not its ingredients. Asserting that
// `isKnownAgent('cos-radar')` is false would prove nothing about whether the
// route consults it — the same tautology found in the radar digest test an hour
// earlier, where an assertion held for reasons unrelated to what it claimed.
const REGISTERED = new Set(['marveen', 'deliverylead', 'architect'])
const known = (id: string) => REGISTERED.has(id)

describe('a receipt is not sent to an address that can never receive it', () => {
  it('skips the receipt for a digest posted by a producer with no session', () => {
    // The exact live row: 21092, the daily radar digest.
    expect(shouldSendReceipt(
      { content: '## COS radar -- szallitas nem igazolt: 0 tetel.', from_agent: 'cos-radar', to_agent: 'marveen' },
      known,
    )).toBe(false)
  })

  it('skips it for the outbound digest producer too', () => {
    expect(shouldSendReceipt(
      { content: '## COS PLANNED kimeno varolista: 1 megfogalmazott level var', from_agent: 'cos-outbound', to_agent: 'marveen' },
      known,
    )).toBe(false)
  })

  // POSITIVE CONTROL: the rule must not silence receipts to real agents. A
  // registered agent whose session is merely DOWN still gets its receipt —
  // that failure is an accident, and accidents are worth retrying.
  it('a real fleet agent still gets its receipt', () => {
    expect(shouldSendReceipt(
      { content: 'Kerlek nezd meg a 00851235 kartyat es jelezz vissza.', from_agent: 'deliverylead', to_agent: 'marveen' },
      known,
    )).toBe(true)
  })

  it('still refuses a notice even from a registered agent', () => {
    // The two reasons are independent; neither may mask the other.
    expect(shouldSendReceipt(
      { content: '[Eredmény] msg_id:1 status:done', from_agent: 'deliverylead', to_agent: 'marveen' },
      known,
    )).toBe(false)
  })

  it('never sends a receipt to itself', () => {
    expect(shouldSendReceipt(
      { content: 'sajat magamnak', from_agent: 'marveen', to_agent: 'marveen' },
      known,
    )).toBe(false)
  })

  // And the LIVE registry really does classify the producers as unregistered —
  // otherwise the rule above would be correct and inert in production.
  it('the live registry agrees: the producers are not fleet agents', () => {
    expect(isKnownAgent('cos-radar')).toBe(false)
    expect(isKnownAgent('cos-outbound')).toBe(false)
    expect(isKnownAgent('marveen')).toBe(true)
  })
})
