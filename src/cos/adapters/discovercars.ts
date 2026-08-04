// DiscoverCars rental adapter — drives the live site headless (Playwright) and
// returns parsed RentalOffers. Implements the RentalAdapter contract: it can
// only SEARCH, never book/pay (assertRentalAdapterSafe enforces it).
//
// Strategy (2026-08-04 recon, see the discovercars-headless-automation-recon
// memory): DiscoverCars' SPA only renders offers for the EXACT window when the
// dates are set in the form's react-date-range calendar BEFORE the first
// submit — a direct sq-URL commits the dates but renders no offers, and
// rewriting the sq on a warm session serves STALE offers. So the driver:
//   1. sets locations via the (reliable) autocomplete + one-way toggle,
//   2. sets dates in the calendar (open by coordinate click; days are
//      `button.rdrDay`), then submits,
//   3. VERIFIES both the committed `sq` dates AND the offers' rendered
//      "Total for N days" against the request — failing LOUD rather than
//      returning wrong-window prices (the calendar commit is the finicky part;
//      the verification guarantees correctness-or-throw).
//
// Playwright is imported dynamically so the dashboard doesn't need it at boot;
// the browser needs LD_LIBRARY_PATH=$HOME/.local/lib/browser-userlibs (NSS libs).

import {
  type RentalAdapter, type RentalSearchParams, type RentalOffer,
  parseDiscoverCarsOffers, sqDatesMatch, rentalDayCount, assertRentalAdapterSafe,
} from '../rental-adapter.js'

const HOME = 'https://www.discovercars.com/'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export interface DiscoverCarsOptions {
  headless?: boolean
  resultTimeoutMs?: number
}

export class DiscoverCarsAdapter implements RentalAdapter {
  readonly id = 'discovercars'
  readonly displayName = 'DiscoverCars'

  constructor(private readonly opts: DiscoverCarsOptions = {}) {
    assertRentalAdapterSafe(this)
  }

  async search(params: RentalSearchParams): Promise<RentalOffer[]> {
    const { chromium } = await import('playwright')
    const b = await chromium.launch({ headless: this.opts.headless ?? true })
    try {
      const ctx = await b.newContext({ locale: 'en-US', userAgent: UA, viewport: { width: 1440, height: 1500 } })
      const p = await ctx.newPage()
      await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await p.waitForTimeout(2500)
      const ck = await p.$('#onetrust-accept-btn-handler')
      if (ck) await ck.click().catch(() => {})
      await p.waitForTimeout(600)

      await selectAutocomplete(p, 'input[name="PickupLocation"]', params.pickup.query, params.pickup.match)
      await p.waitForTimeout(400)
      const same = await p.$('input[name="IsSameLocation"]')
      if (same && (await same.isChecked())) await same.click({ force: true }).catch(() => {})
      await p.waitForTimeout(900)
      await selectAutocomplete(p, 'input[name="DropoffLocation"]', params.dropoff.query, params.dropoff.match)
      await p.waitForTimeout(700)

      await pickDates(p, params.pickupDateTime, params.dropoffDateTime)

      await (await p.$('button.Button_Search, button:has-text("Search now")'))?.click().catch(() => {})
      await p.waitForTimeout(6000)

      // Verify 1: committed sq window == requested.
      const sq = new URL(p.url()).searchParams.get('sq') ?? ''
      if (!sqDatesMatch(sq, params.pickupDateTime, params.dropoffDateTime)) {
        throw new Error(`DiscoverCars committed the wrong window (sq != ${params.pickupDateTime}..${params.dropoffDateTime}); calendar date-commit failed`)
      }

      // lazy-load offers
      const deadline = Date.now() + (this.opts.resultTimeoutMs ?? 48000)
      while (Date.now() < deadline) {
        await p.mouse.wheel(0, 1500)
        await p.waitForTimeout(1800)
        const n = await p.evaluate(() => (document.body.innerText.match(/or similar/g) || []).length)
        if (n > 4) break
      }
      const cardTexts: string[] = await p.evaluate(() => {
        const roots = [...document.querySelectorAll('*')].filter((e) => {
          const t = (e as HTMLElement).innerText || ''
          return /or similar/.test(t) && /Total for/.test(t) && /HUF|EUR|€/.test(t) && e.querySelectorAll('*').length < 80
        }) as HTMLElement[]
        const uniq = roots.filter((e) => !roots.some((o) => o !== e && e.contains(o)))
        return uniq.map((e) => e.innerText)
      })
      const offers = parseDiscoverCarsOffers(cardTexts)

      // Verify 2: the offers' rendered period matches the requested day-count
      // (guards against stale offers surviving from a prior window).
      const wantDays = rentalDayCount(params.pickupDateTime, params.dropoffDateTime)
      const renderedDays = offers.find((o) => o.days != null)?.days
      if (offers.length > 0 && renderedDays != null && renderedDays !== wantDays) {
        throw new Error(`DiscoverCars rendered stale offers ("Total for ${renderedDays} days" != requested ${wantDays}); refusing wrong-window prices`)
      }
      return offers
    } finally {
      await b.close()
    }
  }
}

async function selectAutocomplete(p: any, inputSel: string, query: string, match: string): Promise<void> {
  const el = await p.$(inputSel)
  await el.click()
  await el.fill('')
  await el.type(query, { delay: 55 })
  await p.waitForTimeout(2200)
  const items = await p.$$('.Autocomplete-AutocompleteItem')
  const re = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  for (const it of items) {
    if (re.test((await it.textContent()) || '')) { await it.click(); return }
  }
  if (items[0]) await items[0].click()
}

// Open the react-date-range calendar (coordinate click on the pick-up date box),
// navigate to the pickup month, real-click the pickup day then the dropoff day.
async function pickDates(p: any, pickupDateTime: string, dropoffDateTime: string): Promise<void> {
  const box = await p.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find((e) => {
      const t = (e.textContent || '').trim()
      return /^Pick-?up date/i.test(t) && t.length < 40 && e.querySelectorAll('*').length < 8
    }) as HTMLElement | undefined
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (box) { await p.mouse.click(box.x, box.y); await p.waitForTimeout(1400) }

  const [py, pm, pd] = splitDate(pickupDateTime)
  const [dy, dm, dd] = splitDate(dropoffDateTime)
  await navigateToMonth(p, py, pm)
  await realClickDay(p, pd)
  await p.waitForTimeout(600)
  await navigateToMonth(p, dy, dm)
  await realClickDay(p, dd)
  await p.waitForTimeout(600)
}

function splitDate(dt: string): [number, number, number] {
  const [y, m, d] = dt.split('T')[0].split('-').map(Number)
  return [y, m, d]
}

async function navigateToMonth(p: any, year: number, month1: number): Promise<void> {
  const label = `${MONTHS[month1 - 1]} ${year}`
  for (let i = 0; i < 14; i++) {
    if (await p.evaluate((l: string) => document.body.innerText.includes(l), label)) return
    const next = await p.$('.rdrNextButton')
    if (!next) return
    await next.click().catch(() => {})
    await p.waitForTimeout(400)
  }
}

// Real mouse click on a day cell (react-date-range often ignores synthetic
// .click()). Reads the cell's screen coordinates, then clicks there.
async function realClickDay(p: any, day: number): Promise<boolean> {
  const pt = await p.evaluate((d: number) => {
    const btns = [...document.querySelectorAll('button.rdrDay:not(.rdrDayPassive):not(.rdrDayDisabled)')]
    const btn = btns.find((b) => (b.querySelector('.rdrDayNumber')?.textContent || '').trim() === String(d))
    if (!btn) return null
    const r = (btn as HTMLElement).getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, day)
  if (!pt) return false
  await p.mouse.click(pt.x, pt.y)
  return true
}
