// Which model interprets the goals, and what happens when none is configured.
//
// Istvan's decision 2026-08-10: no Anthropic key exists on this machine, the
// vault holds a DeepSeek one, use DeepSeek. The risk in a fallback chain is that
// it quietly picks something -- so the third branch returns null rather than a
// client that fails later, and these tests pin all three.

import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

// STANDING CHECK — nobody builds their own client and misses the vault.
//
// Review #5, Ö-3: `/api/cos/interpret-answer` constructed `new
// AnthropicLlmClient()` with no arguments. That stores `apiKey: undefined` and
// leaves only the ENV lookup, so the endpoint could not see the vault where the
// Anthropic key actually lives — and the README tells the installer not to set
// ANTHROPIC_API_KEY next to an OAuth token, meaning in the recommended install
// that endpoint could never have worked. Its failure said "the interpreter is
// unavailable", which is indistinguishable from an overloaded model.
//
// The fix is one call site. This check is what keeps it one: a file-level scan,
// because the next such caller will be written by someone who has not read the
// commit that fixed this one.
describe('STANDING CHECK: the interpreter comes from the resolver', () => {
  const REPO = process.cwd()
  const sources = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') sources(rel, out) }
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel)
    }
    return out
  }

  it('no production file constructs an argument-less AnthropicLlmClient', () => {
    const offenders: string[] = []
    for (const f of [...sources('src'), ...sources('scripts')]) {
      // interpreter-provider.ts is the resolver itself; it constructs clients
      // WITH a key on purpose, and that is the one place allowed to.
      if (f === 'src/cos/interpreter-provider.ts') continue
      for (const line of readFileSync(join(REPO, f), 'utf8').split('\n')) {
        // COMMENTS ARE NOT CALL SITES. The first run of this check failed on the
        // sentence in cos.ts that DESCRIBES the bug being fixed — a scan that
        // counts its own prose as an offender teaches people to delete the
        // explanation instead of the defect.
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue
        if (/new AnthropicLlmClient\s*\(\s*\)/.test(line)) offenders.push(`${f}: ${code}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the route reports NOT CONFIGURED differently from NOT ANSWERING', () => {
    // The two facts had one message between them, which is how an endpoint that
    // never worked hid behind "the model is busy".
    const route = readFileSync(join(REPO, 'src/web/routes/cos.ts'), 'utf8')
    expect(route).toContain("cause: 'not_configured'")
    expect(route).toContain("cause: 'call_failed'")
    expect(route).toContain('nincs konfigurált értelmező')
  })
})

// Ö-4: one content, two sensitivity tables, and a field that asserted the older
// answer. `ResolvedInterpreter.profile` was written at five call sites and read
// at none — a policy claim nobody checked, which the next reader would have
// taken as proof that the profile gate runs on the reading path. It does not.
describe('the two sensitivity tables name each other', () => {
  const REPO = process.cwd()
  const read = (f: string): string => readFileSync(join(REPO, f), 'utf8')

  it('no production file carries an unread interpreter profile claim', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(rel) }
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          for (const line of read(rel).split('\n')) {
            const code = line.trim()
            if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue
            if (/INTERPRETER_PROFILE/.test(code)) offenders.push(`${rel}: ${code}`)
          }
        }
      }
    }
    walk('src'); walk('scripts')
    expect(offenders).toEqual([])
  })

  it('each table says which path it governs, and points at the other', () => {
    // The review's actual requirement: "the two tables must reference each other
    // from one place, otherwise the next reader finds one of them and stops".
    expect(read('src/cos/sensitivity.ts')).toContain('provider-data-policy.ts')
    expect(read('src/cos/provider-data-policy.ts')).toContain('profile allowlist')
    expect(read('src/cos/interpreter-provider.ts')).toContain('provider-data-policy.ts')
  })
})
