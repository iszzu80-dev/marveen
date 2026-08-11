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
// Does a method name look like a purchase/checkout action? camelCase-aware so
// that "payNow"/"buyNow" are caught but "payload"/"buyer"/"getOrderHistory"
// (read-only) are not.
export function isForbiddenMethodName(name) {
    // Unambiguous purchase words, anywhere, case-insensitive.
    if (/checkout|purchase|payment/i.test(name))
        return true;
    // Verb + "order" pairs: placeOrder, submit_order, makeOrder, confirmOrder.
    // (Bare "order" is allowed — getOrderHistory/orderDetail are read-only.)
    if (/(?:place|submit|make|confirm)[_\s]?order/i.test(name))
        return true;
    // Ambiguous short roots pay/buy/book/reserve only at a word/camelCase boundary
    // (start or after a non-letter) and followed by end / uppercase / underscore /
    // digit. Case-sensitive on purpose: "payNow"/"bookRental"/"reserve" match,
    // "payload"/"display"/"bookmark" do not. book/reserve are the booking verbs a
    // rental adapter must not expose (payment/booking is always manual).
    if (/(?:^|[^a-zA-Z])(?:pay|buy|book|reserve)(?=[A-Z_\d]|$)/.test(name))
        return true;
    return false;
}
/**
 * Throw if `adapter` exposes any method that looks like a purchase/checkout
 * action. Walks own + prototype-chain method names. This is the structural
 * enforcement of "payment always manual": a wired backend cannot register an
 * adapter that can place an order, regardless of config.
 */
export function assertNoCheckoutSurface(adapter) {
    const names = new Set();
    let o = adapter;
    while (o && o !== Object.prototype) {
        for (const n of Object.getOwnPropertyNames(o))
            names.add(n);
        o = Object.getPrototypeOf(o);
    }
    for (const n of names) {
        if (typeof adapter[n] === 'function' && isForbiddenMethodName(n)) {
            throw new Error(`shopping adapter exposes a forbidden purchase method: "${n}" — autonomous checkout is not allowed (payment is always manual)`);
        }
    }
}
export class ShoppingAdapterRegistry {
    adapters = new Map();
    /** Register an adapter. Rejects a duplicate id and any adapter that exposes a
     *  checkout/purchase method (safety gate). */
    register(adapter) {
        assertNoCheckoutSurface(adapter);
        if (this.adapters.has(adapter.id)) {
            throw new Error(`shopping adapter already registered: ${adapter.id}`);
        }
        this.adapters.set(adapter.id, adapter);
    }
    get(id) {
        return this.adapters.get(id);
    }
    has(id) {
        return this.adapters.has(id);
    }
    list() {
        return [...this.adapters.values()];
    }
}
/**
 * A no-capability placeholder for a provider that is discovered but not yet
 * wired (Alza/eMAG/Tesco/Auchan before their adapters are built, or Kifli
 * before its credentials arrive). Declares no capabilities and returns empty
 * results, so the rest of the COS can enumerate providers without special-
 * casing "not wired yet".
 */
export class StubShoppingAdapter {
    id;
    displayName;
    capabilities = { search: false, priceWatch: false, cart: false };
    constructor(id, displayName) {
        this.id = id;
        this.displayName = displayName;
    }
    async searchProducts() {
        return [];
    }
    async getProduct() {
        return null;
    }
}
