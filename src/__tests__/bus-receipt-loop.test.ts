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
