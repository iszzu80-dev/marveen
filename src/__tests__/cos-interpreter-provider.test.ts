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

  it('asks the vault for exactly one id, and does not go fishing for others', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    const asked: string[] = []
    resolveInterpreter((id) => { asked.push(id); return null })
    expect(asked).toEqual(['DEEPSEEK_API_KEY'])
  })
})
