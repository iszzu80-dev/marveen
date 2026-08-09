// eMAG.hu webshop adapter — the first LIVE product price source for the radar.
//
// "Plain webshop search" (Istvan 2026-08-07): the price aggregators (árukereső,
// Google Shopping) are behind Cloudflare (403 to plain HTTP), so instead we search
// a real webshop directly. eMAG is a large HU marketplace that serves a normal
// search-results page to a browser UA (200, product cards with URLs), and every
// product page carries a schema.org JSON-LD Product/Offer block with the price.
// So the flow is two-hop and robust:
//   1. GET the search page → extract product cards (name + product URL),
//   2. GET the top-N product pages → read offers.price / priceCurrency / availability
//      from JSON-LD (server-rendered, NOT the JS-lazy-loaded card price).
//
// SAFETY: implements the ShoppingAdapter contract, which has NO checkout/purchase
// method (assertNoCheckoutSurface enforces it at registration). This adapter only
// searches and reads prices — it can never buy. Read-only.
//
// HONESTY: it reports ONLY prices it actually parsed. A product eMAG does not carry
// (many fashion items) yields no priced result → the engine records an honest "0
// offers", never a fabricated price. Relevance is the engine's job (mustMatch /
// excludeTerms on the radar item), so a "Cloud" query that hits headphones is
// filtered out downstream rather than mis-reported here.

import type {
  ShoppingAdapter, ShoppingAdapterCapabilities, ProductSearchResult, ProductDetail, ProductRef,
} from '../shopping-adapter.js'

const BASE = 'https://www.emag.hu'
const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
}

// How many of the top search cards to fetch product pages for (each is a network
// round-trip). Bounded so one radar check stays cheap; eMAG ranks by relevance so
// the intended product is near the top when eMAG carries it.
const MAX_PRICE_FETCH = 6

const CURRENCY_MINOR_EXPONENT: Record<string, number> = { HUF: 0, JPY: 0, EUR: 2, USD: 2, GBP: 2, CHF: 2 }
function priceToMinor(price: number, currency: string): number {
  const exp = CURRENCY_MINOR_EXPONENT[currency.toUpperCase()] ?? 2
  return Math.round(price * 10 ** exp)
}

export interface SearchCard { name: string; url: string }

/** Parse the eMAG search results HTML into product cards (name + absolute URL).
 *  Pure — unit-testable without a network. Only the server-rendered card-title
 *  anchors are read (the card PRICE is JS-lazy-loaded, so we get it from the
 *  product page instead). Deduped by URL, order preserved (relevance rank). */
export function parseSearchCards(html: string): SearchCard[] {
  const out: SearchCard[] = []
  const seen = new Set<string>()
  const re = /<a\b[^>]*\bhref="(https:\/\/www\.emag\.hu\/[^"]+\/pd\/[^"]+)"[^>]*class="[^"]*card-v2-title[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const url = m[1]
    const name = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    if (!name || seen.has(url)) continue
    seen.add(url)
    out.push({ name, url })
  }
  return out
}

/** Extract price/currency/availability/name from a product page's schema.org
 *  JSON-LD. Returns null when no Product/Offer with a numeric price is present
 *  (honest: no fabricated price). Pure. */
export function parseProductJsonLd(
  html: string,
): { name: string | null; price: number; currency: string; available: boolean | null } | null {
  const blocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? []
  for (const b of blocks) {
    const jsonText = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim()
    let data: unknown
    try { data = JSON.parse(jsonText) } catch { continue }
    const objs = Array.isArray(data) ? data : [data]
    for (const o of objs) {
      if (!o || typeof o !== 'object') continue
      const rec = o as Record<string, unknown>
      const type = rec['@type']
      const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product')) || 'offers' in rec
      if (!isProduct) continue
      let offer = rec['offers'] as Record<string, unknown> | Array<Record<string, unknown>> | undefined
      if (Array.isArray(offer)) offer = offer[0]
      if (!offer || typeof offer !== 'object') continue
      const rawPrice = (offer as Record<string, unknown>)['price']
      const price = typeof rawPrice === 'string' ? Number(rawPrice) : typeof rawPrice === 'number' ? rawPrice : NaN
      if (!Number.isFinite(price)) continue
      const currency = String((offer as Record<string, unknown>)['priceCurrency'] ?? 'HUF').toUpperCase()
      const avRaw = String((offer as Record<string, unknown>)['availability'] ?? '')
      const available = avRaw ? /InStock/i.test(avRaw) : null
      const name = typeof rec['name'] === 'string' ? (rec['name'] as string) : null
      return { name, price, currency, available }
    }
  }
  return null
}

export interface EmagAdapterOpts { fetchImpl?: typeof fetch }

export class EmagAdapter implements ShoppingAdapter {
  readonly id = 'emag'
  readonly displayName = 'eMAG.hu'
  readonly capabilities: ShoppingAdapterCapabilities = { search: true, priceWatch: true, cart: false }
  private readonly fetch: typeof fetch

  constructor(opts: EmagAdapterOpts = {}) {
    this.fetch = opts.fetchImpl ?? fetch
  }

  private async getText(url: string): Promise<string | null> {
    try {
      const r = await this.fetch(url, { headers: HEADERS })
      if (!r.ok) return null
      return await r.text()
    } catch {
      return null
    }
  }

  async searchProducts(query: string, opts: { limit?: number } = {}): Promise<ProductSearchResult[]> {
    const q = query.trim()
    if (!q) return []
    const html = await this.getText(`${BASE}/search/${encodeURIComponent(q)}`)
    if (!html) return []
    const cards = parseSearchCards(html)
    const budget = Math.min(opts.limit ?? MAX_PRICE_FETCH, MAX_PRICE_FETCH)
    const out: ProductSearchResult[] = []
    for (const card of cards.slice(0, budget)) {
      const detail = await this.priceFor(card.url, card.name)
      if (detail) out.push(detail)
    }
    return out
  }

  async getProduct(ref: ProductRef): Promise<ProductDetail | null> {
    const detail = await this.priceFor(ref.productId, '')
    if (!detail) return null
    return { ...detail, observedAt: Math.floor(Date.now() / 1000) }
  }

  /** Fetch one product page and read its JSON-LD price. `fallbackName` is the
   *  search-card name, used when the page has no JSON-LD name. */
  private async priceFor(url: string, fallbackName: string): Promise<ProductSearchResult | null> {
    const html = await this.getText(url)
    if (!html) return null
    const ld = parseProductJsonLd(html)
    if (!ld) return null
    return {
      ref: { adapterId: this.id, productId: url },
      name: ld.name ?? fallbackName,
      priceMinor: priceToMinor(ld.price, ld.currency),
      currency: ld.currency,
      available: ld.available,
    }
  }
}
