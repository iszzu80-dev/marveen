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
export interface ShoppingAdapterCapabilities {
  search: boolean
  priceWatch: boolean
  cart: boolean
}

export interface ShoppingAdapter {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ShoppingAdapterCapabilities

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
