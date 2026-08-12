// §21 — the Delegation Envelope.
//
// THE STAKES ARE DIFFERENT HERE THAN ANYWHERE ELSE IN THIS SUITE. Every other
// gate in the system decides whether Marveen may do something Istvan asked for.
// This one decides what Marveen may do WITHOUT asking. A false negative costs an
// unnecessary question; a false positive is a letter sent in his name that he
// never saw.
//
// So the tests are asymmetric on purpose. The refusal cases are exhaustive and
// the permission cases are few — which is the same shape as the feature itself.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { initDatabase, getDb } from '../db.js'
import {
  deriveIntent, evaluateEnvelope, revokeEnvelope, restoreEnvelope, envelopeState,
  PERSONAL_EMAIL_ENVELOPE, ZST_EMAIL_ENVELOPE, ENVELOPES,
} from '../cos/delegation-envelope.js'

const T = 1_770_000_000

function freshDb(): Database.Database {
  initDatabase(':memory:')
  return getDb()
}

/** A letter that IS delegable on the personal envelope, so each test below can
 *  change exactly one thing and see it stop being delegable. */
const OK = {
  domain: 'personal' as const, actionType: 'EMAIL_SEND',
  recipient: 'ugyved@example.hu',
  subject: 'Visszajelzés a tervezetre',
  body: 'Megkaptam a tervezetet, továbbítottam a könyvelőnek.',
  outboundKind: 'REPLY' as const,
  now: T,
}

// ── The classifier ────────────────────────────────────────────────────────

describe('§21 — deriveIntent is deterministic and fails closed', () => {
  it('a plain factual reply in an existing thread is recognised', () => {
    expect(deriveIntent({
      subject: 'Visszajelzés', body: 'Megkaptam a tervezetet.', outboundKind: 'REPLY',
    })).toBe('factual_reply')
  })

  it('the same sentence OPENING a thread is not a factual reply', () => {
    // No thread to be factual within — INITIAL never reaches the reply rule.
    expect(deriveIntent({
      subject: 'Visszajelzés', body: 'Megkaptam a tervezetet.', outboundKind: 'INITIAL',
    })).toBe('UNCLASSIFIED')
  })

  it('a price question is a quote_request', () => {
    expect(deriveIntent({
      subject: 'Árajánlat', body: 'Mennyibe kerül a felújítás?', outboundKind: 'INITIAL',
    })).toBe('quote_request')
  })

  it('a scheduling question is recognised', () => {
    expect(deriveIntent({
      subject: 'Időpont', body: 'Mikor lenne alkalmas egy egyeztetés?', outboundKind: 'REPLY',
    })).toBe('non_binding_scheduling_question')
  })

  // THE SAFETY PROPERTY. A disqualifier anywhere in the letter wins over every
  // positive rule — a polite scheduling question that also accepts an offer is
  // not a scheduling question.
  describe('commitment language disqualifies, whatever else the letter looks like', () => {
    const cases: Array<[string, string]> = [
      ['acceptance', 'Mikor lenne alkalmas? Az ajánlatot elfogadom.'],
      ['order', 'Mikor érne rá? Megrendelem a szolgáltatást.'],
      ['contract', 'Mikor egyeztetünk? A szerződést előkészítem aláírásra.'],
      ['payment', 'Mikor alkalmas? Az összeget utalom.'],
      ['booking', 'Mikor lenne jó? Foglalom a időpontot.'],
      ['IBAN', 'Mikor ráér? A számlaszám HU42 1177 3016.'],
      ['english accept', 'When are you free? I accept the offer.'],
    ]
    for (const [name, body] of cases) {
      it(`${name} → UNCLASSIFIED`, () => {
        expect(deriveIntent({ subject: 'Egyeztetés', body, outboundKind: 'REPLY' })).toBe('UNCLASSIFIED')
      })
    }
  })

  it('anything not POSITIVELY recognised is UNCLASSIFIED, even when harmless', () => {
    // "Harmless" is a judgement, and the point of this function is not to make
    // one. An unrecognised letter costs a question, never a send.
    expect(deriveIntent({
      subject: 'Hello', body: 'Mit gondolsz erről az egészről?', outboundKind: 'REPLY',
    })).toBe('UNCLASSIFIED')
  })
})

// ── The envelope ──────────────────────────────────────────────────────────

describe('§21 — evaluateEnvelope', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('delegates the case it was built for', () => {
    const d = evaluateEnvelope(db, OK)
    expect(d.delegated).toBe(true)
    if (d.delegated) {
      expect(d.envelopeId).toBe('pri-email-v1')
      expect(d.intent).toBe('factual_reply')
    }
  })

  it('refuses, with a reason, when the intent is not recognised', () => {
    const d = evaluateEnvelope(db, { ...OK, body: 'Mit gondolsz erről?' })
    expect(d.delegated).toBe(false)
    if (!d.delegated) expect(d.reasons.join(' ')).toMatch(/nem azonosítható/)
  })

  // ISTVAN'S QUESTION 3, AND MY READING OF IT, AS A TEST.
  //
  // "Indíthat új szálat ha nem olyannal kezdi ami komolyabb lépés." Four light
  // intents may open a thread; quote_request may not, because a cold letter to a
  // supplier asking for a price is a business approach made in his name. Inside
  // an existing thread it stays allowed, exactly as he said.
  //
  // If that reading is wrong, this is the test that says so out loud — and the
  // fix is one entry in newThreadIntents.
  describe('new threads: allowed, but not to open with the serious thing', () => {
    it('a scheduling question MAY open a thread', () => {
      const d = evaluateEnvelope(db, {
        ...OK, outboundKind: 'INITIAL',
        subject: 'Időpont', body: 'Mikor lenne alkalmas egy egyeztetés?',
      })
      expect(d.delegated).toBe(true)
    })

    it('a quote request may NOT open one', () => {
      const d = evaluateEnvelope(db, {
        ...OK, outboundKind: 'INITIAL',
        subject: 'Árajánlat', body: 'Mennyibe kerül a felújítás?',
      })
      expect(d.delegated).toBe(false)
      if (!d.delegated) expect(d.reasons.join(' ')).toMatch(/új szálat nem indíthat/)
    })

    it('…but the same quote request INSIDE a thread is delegated', () => {
      const d = evaluateEnvelope(db, {
        ...OK, outboundKind: 'REPLY',
        subject: 'Árajánlat', body: 'Mennyibe kerül a felújítás?',
      })
      expect(d.delegated).toBe(true)
      if (d.delegated) expect(d.intent).toBe('quote_request')
    })

    it('an absent outboundKind is read as opening one — fail-closed', () => {
      const d = evaluateEnvelope(db, {
        ...OK, outboundKind: null,
        subject: 'Árajánlat', body: 'Mennyibe kerül a felújítás?',
      })
      expect(d.delegated).toBe(false)
    })
  })

  // ISTVAN'S QUESTION 4: "valóban nulla most. később ez emelhető lesz."
  it('an amount in the letter refuses while the financial ceiling is zero', () => {
    const d = evaluateEnvelope(db, {
      ...OK, subject: 'Árajánlat', body: 'Mennyibe kerül? A keretem 500 000 Ft.',
    })
    expect(d.delegated).toBe(false)
    if (!d.delegated) expect(d.reasons.join(' ')).toMatch(/pénzügyi kerete nulla/)
  })

  it('the ceiling is a field, so raising it is one reviewed line', () => {
    // Question 4 said "later this can be raised" — encoded as data, not as a
    // hardcoded 0 somebody would have to find.
    expect(PERSONAL_EMAIL_ENVELOPE.maxFinancialCommitment).toBe(0)
    expect(ZST_EMAIL_ENVELOPE.maxFinancialCommitment).toBe(0)
  })

  // ISTVAN'S QUESTION 5: "A könyvelő a relacio@t-online.hu, Inci."
  describe('the corporate allowlist is one name, and that is the whole list', () => {
    function zstReq(
      over: Partial<Omit<typeof OK, 'outboundKind'>>
        & { outboundKind?: 'INITIAL' | 'FOLLOW_UP' | 'REPLY' | null } = {},
    ) {
      return {
        ...OK, domain: 'zst' as const, recipient: 'relacio@t-online.hu',
        subject: 'Visszajelzés', body: 'Megkaptam a bizonylatokat.',
        outboundKind: 'REPLY' as 'INITIAL' | 'FOLLOW_UP' | 'REPLY' | null, ...over,
      }
    }

    it('delegates a reply to the accountant', () => {
      expect(evaluateEnvelope(db, zstReq()).delegated).toBe(true)
    })

    it('refuses anyone else — an unnamed vendor is not on the list', () => {
      const d = evaluateEnvelope(db, zstReq({ recipient: 'szallito@example.hu' }))
      expect(d.delegated).toBe(false)
      if (!d.delegated) expect(d.reasons.join(' ')).toMatch(/nincs a delegálás listáján/)
    })

    it('matches the address case-insensitively', () => {
      expect(evaluateEnvelope(db, zstReq({ recipient: '  Relacio@T-Online.HU ' })).delegated).toBe(true)
    })

    it('the corporate envelope opens NO threads at all', () => {
      const d = evaluateEnvelope(db, zstReq({ outboundKind: 'INITIAL' }))
      expect(d.delegated).toBe(false)
    })

    it('and does not ask suppliers for prices on the company\'s behalf', () => {
      const d = evaluateEnvelope(db, zstReq({
        subject: 'Árajánlat', body: 'Mennyibe kerül a szolgáltatás?',
      }))
      expect(d.delegated).toBe(false)
      if (!d.delegated) expect(d.reasons.join(' ')).toMatch(/quote_request szándék nincs a delegálásban/)
    })
  })

  // ISTVAN'S QUESTION 7: "rossz küldés vagy panasz kapcsolja ki és utána vissza
  // lehessen kapcsolni."
  describe('revocation and restore', () => {
    it('a revoked delegation refuses, and says why', () => {
      revokeEnvelope(db, 'pri-email-v1', 'Istvan panasza: rossz hangnem', T)
      const d = evaluateEnvelope(db, OK)
      expect(d.delegated).toBe(false)
      if (!d.delegated) expect(d.reasons.join(' ')).toMatch(/vissza van vonva.*rossz hangnem/)
    })

    it('restore switches it back on and records who did it', () => {
      revokeEnvelope(db, 'pri-email-v1', 'panasz', T)
      restoreEnvelope(db, 'pri-email-v1', 'istvan', T + 3600)
      expect(evaluateEnvelope(db, { ...OK, now: T + 3600 }).delegated).toBe(true)
      const s = envelopeState(db, 'pri-email-v1')
      expect(s?.revokedAt).toBeNull()
      expect(s?.restoredBy).toBe('istvan')
    })

    // A delegation that comes back by itself was never really withdrawn.
    it('nothing restores it on a timer', () => {
      revokeEnvelope(db, 'pri-email-v1', 'panasz', T)
      expect(evaluateEnvelope(db, { ...OK, now: T + 86_400 * 30 }).delegated).toBe(false)
    })

    // The "rossz küldés" arm: what the system can see for itself.
    it('a send that ended badly under this envelope stops the next one', () => {
      db.prepare(
        `INSERT INTO personal_cases (case_id, title, case_type, status, sensitivity, version, created_at, updated_at)
         VALUES ('c1', 'Ügy', 'ADMIN', 'TRIAGE', 'PERSONAL', 1, ?, ?)`,
      ).run(T, T)
      db.prepare(
        `INSERT INTO outbound_ledger
           (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key, status, created_at, updated_at)
         VALUES ('l-bad', 'c1', 'EMAIL_SEND', 1, 'k-bad', 'FAILED_TERMINAL', ?, ?)`,
      ).run(T, T)
      db.prepare(
        `INSERT INTO action_authorizations
           (authorization_id, domain, case_id, action_id, action_type, intent,
            policy_evaluation_hash, delegation_envelope_id, issued_at, expires_at, nonce)
         VALUES ('a-bad', 'personal', 'c1', 'l-bad', 'EMAIL_SEND', 'factual_reply',
                 'h', 'pri-email-v1', ?, ?, 'n')`,
      ).run(T, T + 60)

      const d = evaluateEnvelope(db, OK)
      expect(d.delegated).toBe(false)
      if (!d.delegated) expect(d.reasons.join(' ')).toMatch(/korábbi hibás küldés.*l-bad/)
    })
  })

  // THE CEILING §21 DOES NOT NAME AND A STANDING DELEGATION CANNOT GO WITHOUT.
  // The campaign approval this replaces carried quota limits; dropping those
  // along with the question would turn "you need not ask me" into "you need not
  // stop".
  it('the daily cap is enforced', () => {
    db.prepare(
      `INSERT INTO personal_cases (case_id, title, case_type, status, sensitivity, version, created_at, updated_at)
       VALUES ('c2', 'Ügy', 'ADMIN', 'TRIAGE', 'PERSONAL', 1, ?, ?)`,
    ).run(T, T)
    for (let i = 0; i < PERSONAL_EMAIL_ENVELOPE.maxSendsPerDay; i++) {
      db.prepare(
        `INSERT INTO outbound_ledger
           (ledger_id, case_id, action_type, sequence_number, internal_idempotency_key, status, created_at, updated_at)
         VALUES (?, 'c2', 'EMAIL_SEND', ?, ?, 'VERIFIED', ?, ?)`,
      ).run(`l${i}`, i + 1, `k${i}`, T, T)
      db.prepare(
        `INSERT INTO action_authorizations
           (authorization_id, domain, case_id, action_id, action_type, intent,
            policy_evaluation_hash, delegation_envelope_id, issued_at, expires_at, nonce)
         VALUES (?, 'personal', 'c2', ?, 'EMAIL_SEND', 'factual_reply', 'h', 'pri-email-v1', ?, ?, ?)`,
      ).run(`a${i}`, `l${i}`, T, T + 60, `n${i}`)
    }
    const d = evaluateEnvelope(db, OK)
    expect(d.delegated).toBe(false)
    if (!d.delegated) expect(d.reasons.join(' ')).toMatch(/napi keret kimerült/)
  })

  it('yesterday\'s sends do not count against today', () => {
    expect(evaluateEnvelope(db, { ...OK, now: T + 86_400 * 2 }).delegated).toBe(true)
  })
})

// ── The wiring ────────────────────────────────────────────────────────────
//
// Every round of this review found a mechanism with no production caller, and
// `delegation_envelope_id` WAS one: a column that travelled the whole system,
// counted towards the policy hash, and was NULL on every row ever written.

describe('§21 — the envelope reaches the send gate, both of them', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('STANDING: neither gate may omit the envelope check', async () => {
    const { readFileSync } = await import('fs')
    for (const f of ['../cos/dispatch-gate.ts', '../cos/zst-send.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(src, `${f} does not consult the envelope`).toMatch(/evaluateEnvelope\(/)
      expect(src, `${f} does not bind the envelope into the permit`).toMatch(/delegationEnvelopeId/)
    }
  })

  // THE SUBSTITUTION IS FOR THE APPROVAL AND FOR NOTHING ELSE. A standing
  // delegation is permission to skip the QUESTION, never a safety layer.
  it('STANDING: the envelope is consulted only after the other layers ran', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(new URL('../cos/dispatch-gate.ts', import.meta.url), 'utf8')
    const connector = src.indexOf('isUsable(db')
    const rung = src.indexOf("permits(db")
    const envelope = src.indexOf('evaluateEnvelope(db')
    expect(connector).toBeGreaterThan(0)
    expect(envelope).toBeGreaterThan(rung)
    expect(rung).toBeGreaterThan(connector)
  })

  it('every envelope has a non-empty allowlist or an explicit null', () => {
    for (const e of ENVELOPES) {
      // An EMPTY array would silently refuse everything and read like a list;
      // null is the deliberate "any recipient the other layers already permit".
      expect(e.recipientAllowlist === null || e.recipientAllowlist.length > 0).toBe(true)
      // newThreadIntents must be a SUBSET of allowedIntents, or an envelope
      // could open a thread with an intent it may not otherwise send.
      for (const i of e.newThreadIntents) expect(e.allowedIntents).toContain(i)
    }
  })
})
