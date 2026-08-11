// Which model interprets the goals, and what happens when none is configured.
//
// Istvan's decision 2026-08-10: no Anthropic key exists on this machine, the
// vault holds a DeepSeek one, use DeepSeek. The risk in a fallback chain is that
// it quietly picks something -- so the third branch returns null rather than a
// client that fails later, and these tests pin all three.

import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveInterpreter, DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_INTERPRETER_MODEL,
} from '../cos/interpreter-provider.js'
import { DEFAULT_INTERPRETER_MODEL } from '../cos/progression-interpreter.js'

const saved = { key: process.env.ANTHROPIC_API_KEY, tok: process.env.ANTHROPIC_AUTH_TOKEN }
afterEach(() => {
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key
  if (saved.tok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved.tok
})

const noSecrets = (): null => null
const vaultWithDeepseek = (id: string): string | null => (id === 'DEEPSEEK_API_KEY' ? 'ds-test-key' : null)

describe('interpreter provider resolution', () => {
  it('prefers an Anthropic key from the environment', () => {
    process.env.ANTHROPIC_API_KEY = 'ant-test'
    const r = resolveInterpreter(vaultWithDeepseek)
    expect(r?.provider).toBe('anthropic')
    expect(r?.model).toBe(DEFAULT_INTERPRETER_MODEL)
  })

  it('falls back to the vault DeepSeek key over the Anthropic-compatible endpoint', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    const r = resolveInterpreter(vaultWithDeepseek)
    expect(r?.provider).toBe('deepseek')
    expect(r?.model).toBe(DEEPSEEK_INTERPRETER_MODEL)
    expect(DEEPSEEK_ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
  })

  it('returns NULL when nothing is configured — never a client that will fail later', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    expect(resolveInterpreter(noSecrets)).toBeNull()
  })

  it('treats a blank vault entry as absent', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    expect(resolveInterpreter(() => '   ')).toBeNull()
  })

  it('asks the vault for exactly the two ids it uses, in preference order', () => {
    // Was ['DEEPSEEK_API_KEY'] until 2026-08-11, when the Anthropic key moved
    // into the vault. The property being pinned is unchanged -- ask for what
    // you use and nothing else -- so the list grew by exactly the id that is
    // now read, in the order the preference chain checks them.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    const asked: string[] = []
    resolveInterpreter((id) => { asked.push(id); return null })
    expect(asked).toEqual(['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY'])
  })
})

describe('vault-stored Anthropic key (2026-08-11)', () => {
  it('HEADLINE: an ANTHROPIC_API_KEY in the VAULT selects Anthropic', () => {
    // The key Istvan handed over went into the vault. The lookup read only
    // process.env, so the provider would have stayed DeepSeek while every
    // report said the switch had happened — a key nobody reads is no key.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    const vault = (id: string): string | null =>
      id === 'ANTHROPIC_API_KEY' ? 'sk-ant-from-vault' : (id === 'DEEPSEEK_API_KEY' ? 'ds-key' : null)
    const r = resolveInterpreter(vault)
    expect(r?.provider).toBe('anthropic')
  })

  it('an empty vault entry does NOT select Anthropic', () => {
    // Whitespace is not a key. Falling through to DeepSeek is correct; picking
    // a client that will fail on first use is not.
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    const vault = (id: string): string | null =>
      id === 'ANTHROPIC_API_KEY' ? '   ' : (id === 'DEEPSEEK_API_KEY' ? 'ds-key' : null)
    expect(resolveInterpreter(vault)?.provider).toBe('deepseek')
  })
})
