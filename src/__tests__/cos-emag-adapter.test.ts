import { describe, it, expect } from 'vitest'
import { EmagAdapter, parseSearchCards, parseProductJsonLd } from '../cos/adapters/emag.js'
import { assertNoCheckoutSurface } from '../cos/shopping-adapter.js'

const SEARCH_HTML = `
<div class="card">
  <h2 class="card-v2-title-wrapper">
    <a href="https://www.emag.hu/on-cloud-6-futocipo-45-feher/pd/AAA111BM/" class="card-v2-title fw-semibold js-product-url" data-zone="title">On Cloud 6 futócipő, 45, fehér</a>
  </h2>
</div>
<div class="card">
  <h2 class="card-v2-title-wrapper">
    <a href="https://www.emag.hu/hyperx-cloud-fejhallgato/pd/BBB222BM/" class="card-v2-title js-product-url" data-zone="title">HyperX Cloud fejhallgató</a>
  </h2>
</div>
<div class="card">
  <a href="https://www.emag.hu/on-cloud-6-futocipo-45-feher/pd/AAA111BM/" class="card-v2-title">On Cloud 6 futócipő, 45, fehér</a>
</div>`

function productHtml(name: string, price: string, currency = 'HUF', avail = 'http://schema.org/InStock') {
  return `<html><head>
    <script type="application/ld+json">{"@type":"Product","name":${JSON.stringify(name)},"offers":{"@type":"Offer","price":"${price}","priceCurrency":"${currency}","availability":"${avail}"}}</script>
  </head><body>...</body></html>`
}

describe('eMAG adapter — search-card + JSON-LD parsing (pure)', () => {
  it('extracts product cards (name + url), deduped by url, order preserved', () => {
    const cards = parseSearchCards(SEARCH_HTML)
    expect(cards).toHaveLength(2) // 3rd is a dup URL
    expect(cards[0]).toEqual({ name: 'On Cloud 6 futócipő, 45, fehér', url: 'https://www.emag.hu/on-cloud-6-futocipo-45-feher/pd/AAA111BM/' })
    expect(cards[1].name).toBe('HyperX Cloud fejhallgató')
  })

  it('parses price/currency/availability/name from JSON-LD', () => {
    const ld = parseProductJsonLd(productHtml('On Cloud 6 futócipő', '41990'))!
    expect(ld.price).toBe(41990)
    expect(ld.currency).toBe('HUF')
    expect(ld.available).toBe(true)
    expect(ld.name).toBe('On Cloud 6 futócipő')
  })

  it('returns null when no JSON-LD price is present (no fabricated price)', () => {
    expect(parseProductJsonLd('<html><body>no structured data</body></html>')).toBeNull()
  })
})

describe('eMAG adapter — live flow (mocked fetch)', () => {
  function mockFetch(pages: Record<string, string>): typeof fetch {
    return (async (url: string) => {
      const body = pages[String(url)]
      if (body == null) return { ok: false, status: 404, text: async () => '' } as Response
      return { ok: true, status: 200, text: async () => body } as Response
    }) as unknown as typeof fetch
  }

  it('two-hop: search page -> product pages -> priced results (HUF minor = major)', async () => {
    const pages = {
      'https://www.emag.hu/search/On%20Cloud%206': SEARCH_HTML,
      'https://www.emag.hu/on-cloud-6-futocipo-45-feher/pd/AAA111BM/': productHtml('On Cloud 6 futócipő, 45, fehér', '41990'),
      'https://www.emag.hu/hyperx-cloud-fejhallgato/pd/BBB222BM/': productHtml('HyperX Cloud fejhallgató', '12706'),
    }
    const a = new EmagAdapter({ fetchImpl: mockFetch(pages) })
    const res = await a.searchProducts('On Cloud 6', { limit: 5 })
    expect(res).toHaveLength(2)
    const shoe = res.find(r => r.name.includes('futócipő'))!
    expect(shoe.priceMinor).toBe(41990) // HUF exponent 0
    expect(shoe.currency).toBe('HUF')
    expect(shoe.available).toBe(true)
    expect(shoe.ref.adapterId).toBe('emag')
  })

  it('converts non-HUF price to minor units', async () => {
    const pages = {
      'https://www.emag.hu/search/x': `<a href="https://www.emag.hu/p/pd/C1/" class="card-v2-title">P</a>`,
      'https://www.emag.hu/p/pd/C1/': productHtml('P', '99.90', 'EUR'),
    }
    const a = new EmagAdapter({ fetchImpl: mockFetch(pages) })
    const res = await a.searchProducts('x')
    expect(res[0].priceMinor).toBe(9990) // 99.90 EUR -> 9990 minor
    expect(res[0].currency).toBe('EUR')
  })

  it('empty query and search failure return [] (honest, no crash)', async () => {
    const a = new EmagAdapter({ fetchImpl: mockFetch({}) })
    expect(await a.searchProducts('')).toEqual([])
    expect(await a.searchProducts('anything')).toEqual([]) // 404 search page
  })

  it('exposes NO checkout/purchase surface (safety contract)', () => {
    expect(() => assertNoCheckoutSurface(new EmagAdapter())).not.toThrow()
  })
})
