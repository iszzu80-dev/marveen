// Personal Chief of Staff (COS) Slice 0 — shopping adapter contract.
//
// One provider-agnostic interface that every shopping backend implements:
// the Kifli MCP (cart-capable), Alza (read-only price radar), and the
// browser adapters (eMAG/Tesco/Auchan). It exposes search, price-watch, and
// CART-PREP only.
//
// SAFETY INVARIANT (spec v4.2.1: payment always manual, autonomous_spend_limit=0):
// there is deliberately NO placeOrder / checkout / pay method anywhere in this
// contract, and no `order` capability flag. Autonomous purchase is therefore
// structurally impossible, not merely disabled by config — the human completes
// checkout in the retailer UI. `assertNoCheckoutSurface` is a defensive
// registration guard so that wrapping a richer backend (e.g. an MCP that also
// exposes a checkout tool) cannot smuggle a purchase method past the contract.

export interface ProductRef {
  adapterId: string
  productId: string
}

/**
 * Minor-unit exponent per currency (HUF and JPY have none: 100 Ft = 100 minor).
 *
 * ONE table, deliberately. It used to exist twice — once in the eMAG adapter
 * (major → minor on the way in) and once in radar-runner (minor → major on the
 * way out) — which is a pair that must agree exactly: a currency added to one
 * side and not the other mis-scales every price on that radar item by 100×, and
 * the direction of the error decides whether the owner is spammed with fake HITs
 * or never told about a real one. Adapters convert INTO minor units, the radar
 * converts back OUT; both read this.
 */
export const CURRENCY_MINOR_EXPONENT: Record<string, number> = { HUF: 0, JPY: 0, EUR: 2, USD: 2, GBP: 2, CHF: 2 }

/** Exponent for a currency, defaulting to 2 (the common case) for unknown codes. */
export function currencyMinorExponent(currency: string | null | undefined): number {
  return CURRENCY_MINOR_EXPONENT[(currency ?? 'HUF').toUpperCase()] ?? 2
}

export interface ProductSearchResult {
  ref: ProductRef
  name: string
  /** Price in minor units (e.g. fillér/cent); null when unknown. */
  priceMinor: number | null
  currency: string | null
  available: boolean | null
  unit?: string
}

export interface ProductDetail extends ProductSearchResult {
  description?: string
  /** Unix seconds when this price/detail was observed (for the price radar). */
  observedAt: number
}

export interface CartLine {
  productId: string
  quantity: number
}

export interface CartState {
  lines: Array<{ productId: string; name?: string; quantity: number; priceMinor?: number | null }>
  /** The retailer's own "cart is orderable" flag — informational only; the COS
   *  never acts on it to place an order (there is no method to). */
  canMakeOrder: boolean
  totalMinor?: number | null
  currency?: string | null
}

export interface CartMutationResult {
  ok: boolean
  affected: string[]
  message?: string
}

// NOTE: no `order` / `checkout` / `pay` flag exists here, by design.
import type { Shippability } from './radar.js'

export interface ShoppingAdapterCapabilities {
  search: boolean
  priceWatch: boolean
  cart: boolean
}

export interface ShoppingAdapter {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ShoppingAdapterCapabilities

  /**
   * Does this source deliver to Hungary?
   *
   * A property of the SOURCE, not of a guess about one offer: a Hungarian
   * storefront (emag.hu) delivers here by construction, while a price scraped
   * off the open web says nothing about it. Adapters that cannot answer must
   * leave this undefined, which is read as 'UNKNOWN' — never as 'YES'.
   *
   * Declared here rather than inferred per result so a new adapter has to state
   * its answer to be wired in. An adapter that forgets gets 'UNKNOWN' and its
   * finds surface on the "delivery not verified" line: visible, but never sold
   * to Istvan as a deal we cannot confirm he can receive.
   */
  readonly deliversToHu?: Shippability

  // Always available (even browser/scraper adapters can search).
  searchProducts(query: string, opts?: { limit?: number }): Promise<ProductSearchResult[]>
  getProduct(ref: ProductRef): Promise<ProductDetail | null>

  // Present ONLY when capabilities.cart is true. Cart-prep, never checkout.
  getCart?(): Promise<CartState>
  addToCart?(lines: CartLine[]): Promise<CartMutationResult>
  removeFromCart?(productId: string): Promise<CartMutationResult>
}

// Does a method name look like a purchase/checkout action? camelCase-aware so
// that "payNow"/"buyNow" are caught but "payload"/"buyer"/"getOrderHistory"
// (read-only) are not.
export function isForbiddenMethodName(name: string): boolean {
  // Unambiguous purchase words, anywhere, case-insensitive.
  if (/checkout|purchase|payment/i.test(name)) return true
  // Verb + "order" pairs: placeOrder, submit_order, makeOrder, confirmOrder.
  // (Bare "order" is allowed — getOrderHistory/orderDetail are read-only.)
  if (/(?:place|submit|make|confirm)[_\s]?order/i.test(name)) return true
  // Ambiguous short roots pay/buy/book/reserve only at a word/camelCase boundary
  // (start or after a non-letter) and followed by end / uppercase / underscore /
  // digit. Case-sensitive on purpose: "payNow"/"bookRental"/"reserve" match,
  // "payload"/"display"/"bookmark" do not. book/reserve are the booking verbs a
  // rental adapter must not expose (payment/booking is always manual).
  if (/(?:^|[^a-zA-Z])(?:pay|buy|book|reserve)(?=[A-Z_\d]|$)/.test(name)) return true
  return false
}

/**
 * Throw if `adapter` exposes any method that looks like a purchase/checkout
 * action. Walks own + prototype-chain method names. This is the structural
 * enforcement of "payment always manual": a wired backend cannot register an
 * adapter that can place an order, regardless of config.
 */
export function assertNoCheckoutSurface(adapter: object): void {
  const names = new Set<string>()
  let o: unknown = adapter
  while (o && o !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(o)) names.add(n)
    o = Object.getPrototypeOf(o)
  }
  for (const n of names) {
    if (typeof (adapter as Record<string, unknown>)[n] === 'function' && isForbiddenMethodName(n)) {
      throw new Error(
        `shopping adapter exposes a forbidden purchase method: "${n}" — autonomous checkout is not allowed (payment is always manual)`,
      )
    }
  }
}

export class ShoppingAdapterRegistry {
  private readonly adapters = new Map<string, ShoppingAdapter>()

  /** Register an adapter. Rejects a duplicate id and any adapter that exposes a
   *  checkout/purchase method (safety gate). */
  register(adapter: ShoppingAdapter): void {
    assertNoCheckoutSurface(adapter)
    if (this.adapters.has(adapter.id)) {
      throw new Error(`shopping adapter already registered: ${adapter.id}`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): ShoppingAdapter | undefined {
    return this.adapters.get(id)
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  list(): ShoppingAdapter[] {
    return [...this.adapters.values()]
  }
}

/**
 * A no-capability placeholder for a provider that is discovered but not yet
 * wired (Alza/eMAG/Tesco/Auchan before their adapters are built, or Kifli
 * before its credentials arrive). Declares no capabilities and returns empty
 * results, so the rest of the COS can enumerate providers without special-
 * casing "not wired yet".
 */
export class StubShoppingAdapter implements ShoppingAdapter {
  readonly capabilities: ShoppingAdapterCapabilities = { search: false, priceWatch: false, cart: false }
  constructor(
    readonly id: string,
    readonly displayName: string,
  ) {}
  async searchProducts(): Promise<ProductSearchResult[]> {
    return []
  }
  async getProduct(): Promise<ProductDetail | null> {
    return null
  }
}
