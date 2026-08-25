import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideDisclosure, type DestinationTrustClass } from '../cos/disclosure.js'

// W13 / §7.3 — ONE trust vocabulary, two enforcement points, proven to agree.
//
// The audit found three separate two-valued decisions (the WebFetch allowlist,
// the LLM provider's data class, the quarantine-reader's host list) and no
// shared vocabulary, which is why §7.4's disclosure record had no class to name.
// The four classes now exist once, in `src/cos/disclosure.ts`, and the WebFetch
// gate answers in them.
//
// The risk of "the same four strings in two files" is obvious, and it is the
// defect this repository has spent two packets closing. So this test imports
// BOTH sides and compares them, rather than reading like a promise that they
// were kept in step.

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'hooks', 'egress-gate.mjs')

interface Hook {
  trustClassOfUrl: (url: string, runtimeList?: { domains: string[]; prefixes: string[] }) => string
  isEgressBlocked: (tool: string, input: { url: string }, runtimeList?: { domains: string[]; prefixes: string[] }) => boolean
}

/** Import the hook as a module. Safe: it only runs its main path when invoked
 *  directly (isInvokedDirectly), which is why the port-validation test can spawn
 *  it as a subprocess while this one imports it. */
async function hook(): Promise<Hook> {
  return await import(HOOK) as unknown as Hook
}

const OPERATOR_LIST = { domains: ['ops.example.com'], prefixes: ['https://vendor.example.net/api/'] }

describe('W13 §7.3 — the WebFetch boundary speaks the shared vocabulary', () => {
  it('classifies each kind of destination', async () => {
    const h = await hook()
    expect(h.trustClassOfUrl('http://localhost:3420/api/agents')).toBe('TRUSTED_INTERNAL')
    expect(h.trustClassOfUrl('http://127.0.0.1:11434/api/generate')).toBe('TRUSTED_INTERNAL')
    expect(h.trustClassOfUrl('https://api.github.com/repos/x')).toBe('APPROVED_EXTERNAL')
    expect(h.trustClassOfUrl('https://gmail.googleapis.com/v1/x')).toBe('APPROVED_EXTERNAL')
    expect(h.trustClassOfUrl('https://ops.example.com/x', OPERATOR_LIST)).toBe('RESTRICTED_EXTERNAL')
    expect(h.trustClassOfUrl('https://vendor.example.net/api/x', OPERATOR_LIST)).toBe('RESTRICTED_EXTERNAL')
    expect(h.trustClassOfUrl('https://evil.example.com/collect', OPERATOR_LIST)).toBe('UNKNOWN_UNTRUSTED')
  })

  it('an operator-added host is RESTRICTED, not APPROVED — the difference is a relationship, not a preference', async () => {
    const h = await hook()
    // "The owner allowed this host" and "there is a data-processing agreement
    // with this vendor" are different facts. Collapsing them would let a host
    // added for one read receive whatever an approved provider may receive.
    expect(h.trustClassOfUrl('https://ops.example.com/x', OPERATOR_LIST)).not.toBe('APPROVED_EXTERNAL')
  })

  it('the CLASS and the ALLOW/DENY answer cannot disagree', async () => {
    const h = await hook()
    const urls = [
      'http://localhost:3420/api/agents',
      'https://api.github.com/x',
      'https://ops.example.com/x',
      'https://vendor.example.net/api/x',
      'https://evil.example.com/x',
      'https://api.github.com.evil.com/x',
      'not-a-url',
    ]
    for (const u of urls) {
      const blocked = h.isEgressBlocked('WebFetch', { url: u }, OPERATOR_LIST)
      const cls = h.trustClassOfUrl(u, OPERATOR_LIST)
      // Blocked ⟺ unknown. Two derivations of one fact, checked against each
      // other rather than each against my expectation of it.
      expect(cls === 'UNKNOWN_UNTRUSTED', `${u} → blocked=${blocked} class=${cls}`).toBe(blocked)
    }
  })

  it('the ONE divergence is the malformed call, and it diverges in the safe direction', async () => {
    // Found by the cross-check above rather than reasoned about in advance: a
    // WebFetch with an EMPTY url is not blocked (the hook's stated policy —
    // "malformed/empty input must never block the agent"; the tool call fails on
    // its own), while the class of an empty url is UNKNOWN_UNTRUSTED.
    //
    // They are answering different questions and both answers are right. The
    // gate is asked "should I stop this call", and stopping a malformed call
    // buys nothing. The class is asked "may data go here", and the answer for a
    // destination that does not exist is no. Recorded here so the next reader
    // finds a documented difference instead of an apparent contradiction.
    const h = await hook()
    expect(h.isEgressBlocked('WebFetch', { url: '' }, OPERATOR_LIST)).toBe(false)
    expect(h.trustClassOfUrl('', OPERATOR_LIST)).toBe('UNKNOWN_UNTRUSTED')
  })

  it('the four class names are EXACTLY the ones the disclosure policy uses', async () => {
    const h = await hook()
    // Not a string comparison against a literal list in this test: each name is
    // fed to the disclosure engine, which only accepts its own vocabulary, and
    // an unknown class would produce a different decision shape.
    const classes = [
      h.trustClassOfUrl('http://localhost:3420/x'),
      h.trustClassOfUrl('https://api.github.com/x'),
      h.trustClassOfUrl('https://ops.example.com/x', OPERATOR_LIST),
      h.trustClassOfUrl('https://evil.example.com/x'),
    ] as DestinationTrustClass[]
    expect(new Set(classes).size).toBe(4)

    for (const trustClass of classes) {
      const d = decideDisclosure({
        actor: 'test', onBehalfOf: 'istvan', runId: null,
        destination: 'web:' + trustClass, trustClass,
        taskTier: 'SUMMARIZE_EXTRACT', caseSensitivity: 'PERSONAL',
        fields: [{ kind: 'BODY_FULL', value: 'x' }], requiredFields: ['BODY_FULL'],
      })
      // Every class produces a real decision with a stated reason — no class
      // falls through to an accidental default.
      expect(d.outcomes[0].reason.length).toBeGreaterThan(0)
    }
  })

  it('and the classes ORDER the way the policy expects: stricter class, less disclosed', async () => {
    const h = await hook()
    const forClass = (trustClass: DestinationTrustClass) => decideDisclosure({
      actor: 'test', onBehalfOf: 'istvan', runId: null,
      destination: 'web:x', trustClass,
      taskTier: 'SUMMARIZE_EXTRACT', caseSensitivity: 'PERSONAL',
      fields: [
        { kind: 'BODY_FULL', value: 'Hatarido 2026-09-01' },
        { kind: 'SENDER_EXACT', value: 'a@b.hu' },
      ],
      requiredFields: ['BODY_FULL', 'SENDER_EXACT'],
    }).disclosedKinds.length

    expect(forClass(h.trustClassOfUrl('http://localhost:3420/x') as DestinationTrustClass)).toBe(2)
    expect(forClass(h.trustClassOfUrl('https://api.github.com/x') as DestinationTrustClass)).toBe(2)
    expect(forClass(h.trustClassOfUrl('https://ops.example.com/x', OPERATOR_LIST) as DestinationTrustClass)).toBe(0)
    expect(forClass(h.trustClassOfUrl('https://evil.example.com/x') as DestinationTrustClass)).toBe(0)
  })
})
