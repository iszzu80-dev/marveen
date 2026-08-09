import { describe, it, expect } from 'vitest'
import {
  coerceZstSensitivity, escalateZstSensitivity, classifyZstSensitivity,
  effectiveZstSensitivity, isProfileAllowedForZstSensitivity, evaluateZstDispatch,
  MOST_RESTRICTED,
} from '../cos/zst-sensitivity.js'

// ZST Slice 0 static sensitivity policy (spec §14): fail-closed, escalate-only,
// static model-profile allowlist.

describe('ZST sensitivity policy', () => {
  describe('fail-closed coercion (spec §14.2)', () => {
    it('coerces UNKNOWN and any unrecognised value to the most restricted class', () => {
      expect(coerceZstSensitivity('UNKNOWN')).toBe(MOST_RESTRICTED)
      expect(coerceZstSensitivity('nonsense')).toBe(MOST_RESTRICTED)
      expect(coerceZstSensitivity(undefined)).toBe(MOST_RESTRICTED)
      expect(coerceZstSensitivity(null)).toBe(MOST_RESTRICTED)
      expect(coerceZstSensitivity(42)).toBe(MOST_RESTRICTED)
    })
    it('keeps a known class', () => {
      expect(coerceZstSensitivity('ZST_FINANCIAL')).toBe('ZST_FINANCIAL')
      expect(coerceZstSensitivity('PUBLIC')).toBe('PUBLIC')
    })
  })

  describe('escalation (only raises)', () => {
    it('returns the more restricted of two classes', () => {
      expect(escalateZstSensitivity('PUBLIC', 'ZST_FINANCIAL')).toBe('ZST_FINANCIAL')
      expect(escalateZstSensitivity('ZST_HIGHLY_SENSITIVE', 'ZST_INTERNAL')).toBe('ZST_HIGHLY_SENSITIVE')
    })
    it('effective tier never falls below the declared tier', () => {
      // benign content, but declared FINANCIAL -> stays FINANCIAL
      expect(effectiveZstSensitivity('ZST_FINANCIAL', 'hello world')).toBe('ZST_FINANCIAL')
    })
  })

  describe('content classifier', () => {
    it('flags credentials as HIGHLY_SENSITIVE', () => {
      expect(classifyZstSensitivity('key: rnd_ABCDEFGHIJKLMNOPQRSTUV').tier).toBe('ZST_HIGHLY_SENSITIVE')
    })
    it('flags an IBAN in a bank context as FINANCIAL', () => {
      expect(classifyZstSensitivity('utalás IBAN HU42117730161111101800000000').tier).toBe('ZST_FINANCIAL')
    })
    it('flags contract language as LEGAL', () => {
      expect(classifyZstSensitivity('a szerződés felmondása és a kötbér a felek aláírásával').tier).toBe('ZST_LEGAL')
    })
    it('flags contact PII as PERSONAL_DATA', () => {
      expect(classifyZstSensitivity('elérhetőség: partner@example.com').tier).toBe('ZST_PERSONAL_DATA')
    })
    it('benign content is PUBLIC', () => {
      expect(classifyZstSensitivity('a heti státusz zöld').tier).toBe('PUBLIC')
    })
  })

  describe('model-profile allowlist (spec §14.3)', () => {
    it('restricts financial/legal/highly to premium_reasoning only', () => {
      expect(isProfileAllowedForZstSensitivity('premium_reasoning', 'ZST_FINANCIAL')).toBe(true)
      expect(isProfileAllowedForZstSensitivity('analysis_efficient', 'ZST_FINANCIAL')).toBe(false)
      expect(isProfileAllowedForZstSensitivity('build_strong', 'ZST_LEGAL')).toBe(false)
    })
    it('fail-closed: unknown tier denies all but the most-controlled profile', () => {
      expect(isProfileAllowedForZstSensitivity('analysis_efficient', 'garbage')).toBe(false)
      expect(isProfileAllowedForZstSensitivity('premium_reasoning', 'garbage')).toBe(true)
    })
    it('unknown profile is never allowed', () => {
      expect(isProfileAllowedForZstSensitivity('no_such_profile', 'PUBLIC')).toBe(false)
    })
  })

  describe('evaluateZstDispatch end-to-end', () => {
    it('blocks an efficient profile on financial content, allows premium', () => {
      const content = 'számla IBAN HU42117730161111101800000000 fizetendő'
      expect(evaluateZstDispatch(content, 'ZST_INTERNAL', 'analysis_efficient').verdict).toBe('block')
      expect(evaluateZstDispatch(content, 'ZST_INTERNAL', 'premium_reasoning').verdict).toBe('allow')
    })
  })
})
