// Personal Chief of Staff (COS) — marker-persistence gate (spec P1.3, AC-26).
//
// The whole executor crash-safety rests on ONE assumption: the searchable
// idempotency marker embedded in an outbound message can be READ BACK from the
// provider. If that is not true for a given adapter, readback is blind and
// double-send cannot be ruled out — so that adapter MUST NOT be granted EXECUTE.
//
// This module turns that assumption into a proof. verifyMarkerPersistence drives
// a real send + readback through the adapter and checks the 5 points the spec
// requires:
//   1. a test message is sent and returns a provider message id;
//   2. it can be read back from the provider;
//   3. the read-back provider id matches the sent id;
//   4. the read-back was by the marker (custom header / deterministic id), i.e.
//      the marker is genuinely searchable (readback available AND found);
//   5. timeout recovery is proven — covered by the executor's reach-then-throw
//      tests (cos-executor / cos-gmail-send): a send that reached the provider
//      then errored recovers to VERIFIED with no second delivery.
//
// Gmail EXECUTE stays gated to PREPARE until this passes against the REAL Gmail
// transport (which needs the write-scope consent). Against the DryRunTransport it
// passes, proving the contract itself is sound.

import type { OutboundAdapter, OutboundAction } from './executor.js'

export interface MarkerPersistenceReport {
  passed: boolean
  sent: boolean            // (1) a provider message id came back
  readbackFound: boolean   // (2)+(4) the marker was found on readback (searchable)
  readbackAvailable: boolean
  refMatches: boolean      // (3) the read-back provider id matches the sent id
  detail: string
}

export type OutboundMode = 'EXECUTE' | 'PREPARE'

/** A throwaway action to probe an adapter with. The marker is what the adapter
 *  must embed and be able to find. Not persisted to any ledger — this is a live
 *  contract probe, so use a test recipient (e.g. send-to-self). */
export function probeAction(marker: string, payload: unknown): OutboundAction {
  return {
    ledgerId: `probe-${marker}`,
    caseId: null,
    actionType: 'EMAIL_SEND',
    sequenceNumber: 0,
    internalIdempotencyKey: marker,
    externalIdempotencyMarker: marker,
    payload,
    status: 'PLANNED',
    externalRef: null,
    attempt: 0,
  }
}

/**
 * Run the marker round-trip through the adapter: send → readback by the marker →
 * confirm the provider id matches. Returns a report; markerPersistenceGate turns
 * it into EXECUTE / PREPARE. This SENDS via the adapter's transport, so with a
 * real transport it delivers a test message (send-to-self) — run it deliberately,
 * not on every boot.
 */
export async function verifyMarkerPersistence(
  adapter: OutboundAdapter, sample: OutboundAction,
): Promise<MarkerPersistenceReport> {
  let sentRef: string | null = null
  try {
    const s = await adapter.send(sample)
    sentRef = s.externalRef || null
  } catch (err) {
    return { passed: false, sent: false, readbackFound: false, readbackAvailable: false, refMatches: false, detail: `send threw: ${String((err as Error)?.message ?? err)}` }
  }
  let rb: { found: boolean; available?: boolean; externalRef?: string }
  try {
    rb = await adapter.readback(sample.externalIdempotencyMarker)
  } catch (err) {
    return { passed: false, sent: !!sentRef, readbackFound: false, readbackAvailable: false, refMatches: false, detail: `readback threw: ${String((err as Error)?.message ?? err)}` }
  }
  const readbackAvailable = rb.available !== false
  const readbackFound = rb.found === true
  const refMatches = rb.externalRef != null && sentRef != null && rb.externalRef === sentRef
  // F-10: refMatches is part of `passed`. B.3's third condition is that the
  // provider id read back is the id we were given on send; it used to be
  // computed, printed into the detail string ("id not compared") and then left
  // out of the verdict. A check that only appears in prose is a report, not a
  // gate — and the point of this whole module is to be a gate.
  //
  // An adapter whose readback does not return an id at all cannot satisfy the
  // condition, and that is the intended answer: it has not PROVEN persistence,
  // so it stays in PREPARE. Failing closed here costs a manual mode flip;
  // failing open costs a send nobody can verify.
  const passed = !!sentRef && readbackAvailable && readbackFound && refMatches
  const detail = passed
    ? `marker round-trips (sent ${sentRef}, read back ${rb.externalRef ?? '?'}, ids match)`
    : `sent=${!!sentRef} available=${readbackAvailable} found=${readbackFound} idsMatch=${refMatches}`
  return { passed, sent: !!sentRef, readbackFound, readbackAvailable, refMatches, detail }
}

/** The gate: an adapter may only EXECUTE if its marker persistence is proven.
 *  Otherwise it stays PREPARE (build the message, never send). */
export function markerPersistenceGate(report: MarkerPersistenceReport): OutboundMode {
  return report.passed ? 'EXECUTE' : 'PREPARE'
}
