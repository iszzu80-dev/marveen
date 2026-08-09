import { describe, it, expect } from 'vitest'
import {
  ShoppingAdapterRegistry,
  StubShoppingAdapter,
  assertNoCheckoutSurface,
  type ShoppingAdapter,
  type ProductSearchResult,
  type ProductDetail,
  type CartState,
  type CartMutationResult,
} from '../cos/shopping-adapter.js'

// COS Slice 0 — shopping adapter contract. The headline property is the SAFETY
// invariant: no adapter can expose a checkout/purchase method. Registration
// enforces it structurally, so "payment always manual" is not a config toggle.

// A compliant cart-capable adapter (the shape the Kifli MCP wrapper will take).
class CompliantCartAdapter implements ShoppingAdapter {
  readonly id = 'kifli'
  readonly displayName = 'Kifli.hu'
  readonly capabilities = { search: true, priceWatch: true, cart: true }
  async searchProducts(): Promise<ProductSearchResult[]> {
    return [{ ref: { adapterId: 'kifli', productId: 'p1' }, name: 'Tej', priceMinor: 39900, currency: 'HUF', available: true }]
  }
  async getProduct(): Promise<ProductDetail | null> {
    return { ref: { adapterId: 'kifli', productId: 'p1' }, name: 'Tej', priceMinor: 39900, currency: 'HUF', available: true, observedAt: 1_700_000_000 }
  }
  async getCart(): Promise<CartState> {
    return { lines: [], canMakeOrder: false }
  }
  async addToCart(): Promise<CartMutationResult> {
    return { ok: true, affected: ['p1'] }
  }
  async removeFromCart(): Promise<CartMutationResult> {
    return { ok: true, affected: ['p1'] }
  }
}

describe('assertNoCheckoutSurface (structural payment-manual guard)', () => {
  it('passes a compliant adapter (search/cart-prep only)', () => {
    expect(() => assertNoCheckoutSurface(new CompliantCartAdapter())).not.toThrow()
  })

  it('passes the stub adapter', () => {
    expect(() => assertNoCheckoutSurface(new StubShoppingAdapter('alza', 'Alza'))).not.toThrow()
  })

  it.each(['checkout', 'placeOrder', 'place_order', 'submitOrder', 'makeOrder', 'confirmOrder', 'pay', 'payNow', 'payment', 'purchase', 'buy', 'buyNow'])(
    'throws when an adapter exposes a "%s" method',
    (methodName) => {
      const rogue: Record<string, unknown> = {
        id: 'rogue',
        displayName: 'Rogue',
        capabilities: { search: true, priceWatch: false, cart: true },
        async searchProducts() { return [] },
        async getProduct() { return null },
        [methodName]: async () => ({ ok: true }),
      }
      expect(() => assertNoCheckoutSurface(rogue)).toThrow(/forbidden purchase method/i)
    },
  )

  it('does NOT false-positive on the legitimate cart-prep methods', () => {
    // addToCart / removeFromCart / getCart / searchProducts / getProduct must survive.
    expect(() => assertNoCheckoutSurface(new CompliantCartAdapter())).not.toThrow()
  })
})

describe('ShoppingAdapterRegistry', () => {
  it('registers, gets, has, lists', () => {
    const reg = new ShoppingAdapterRegistry()
    const a = new CompliantCartAdapter()
    reg.register(a)
    expect(reg.has('kifli')).toBe(true)
    expect(reg.get('kifli')).toBe(a)
    expect(reg.list().map((x) => x.id)).toEqual(['kifli'])
    expect(reg.get('nope')).toBeUndefined()
  })

  it('rejects a duplicate id', () => {
    const reg = new ShoppingAdapterRegistry()
    reg.register(new CompliantCartAdapter())
    expect(() => reg.register(new CompliantCartAdapter())).toThrow(/already registered/i)
  })

  it('rejects an adapter with a checkout method AT REGISTRATION (safety gate)', () => {
    const reg = new ShoppingAdapterRegistry()
    const rogue = Object.assign(new CompliantCartAdapter(), {
      async checkout() { return { ok: true } },
    })
    expect(() => reg.register(rogue as unknown as ShoppingAdapter)).toThrow(/forbidden purchase method/i)
    expect(reg.has('kifli')).toBe(false) // not registered
  })
})

describe('StubShoppingAdapter (discovered-but-not-wired)', () => {
  it('declares no capabilities and returns empty results', async () => {
    const stub = new StubShoppingAdapter('emag', 'eMAG')
    expect(stub.capabilities).toEqual({ search: false, priceWatch: false, cart: false })
    expect(await stub.searchProducts()).toEqual([])
    expect(await stub.getProduct()).toBeNull()
  })
})

describe('capabilities shape has no order/checkout flag', () => {
  it('only exposes search/priceWatch/cart', () => {
    const caps = new CompliantCartAdapter().capabilities
    expect(Object.keys(caps).sort()).toEqual(['cart', 'priceWatch', 'search'])
  })
})
