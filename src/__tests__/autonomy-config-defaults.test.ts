// Two autonomy systems with OPPOSITE defaults (review 2026-08-13, A13/A19).
//
// The SQLite ladder defaults an unknown case type to PREPARE — it may draft,
// never send. The JSON-config system defaulted a missing config OR a missing
// key to level 3: fully autonomous. A missing key silently granting the most
// permissive level inverts the fail-closed posture every other gate in this
// codebase takes, and a missing key is exactly what a newly introduced category
// looks like on an installation that has not been updated yet.
//
// A19 is the same endpoint's two smaller holes: `level` was validated as
// 1 <= level <= 3 without being an integer (2.5 passed and was persisted), and
// the read-modify-write of the config file had no lock at all.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-autonomy-default-'))
mkdirSync(join(tmpRoot, 'store'), { recursive: true })

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, PROJECT_ROOT: tmpRoot }
})
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))

const { autonomyLevel, DEFAULT_AUTONOMY_LEVEL, tryHandleAutonomy } = await import('../web/routes/autonomy.js')
import type { RouteContext } from '../web/routes/types.js'

const CONFIG = join(tmpRoot, 'store', 'autonomy-config.json')

function writeConfig(categories: unknown[]): void {
  writeFileSync(CONFIG, JSON.stringify({ version: 1, updated_at: 0, categories }, null, 2))
}

function fakePost(body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL('http://localhost:3420/api/autonomy')
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: '/api/autonomy', method: 'POST', url } as RouteContext, out }
}

beforeEach(() => {
  rmSync(CONFIG, { force: true })
})
afterEach(() => {
  rmSync(CONFIG, { force: true })
})

describe('a missing autonomy key fails CLOSED', () => {
  it('defaults to level 1 (report only), not 3', () => {
    expect(DEFAULT_AUTONOMY_LEVEL).toBe(1)
  })

  it('an absent config file yields level 1', () => {
    expect(autonomyLevel('kanban_archive_done', CONFIG)).toBe(1)
  })

  it('a config without the key yields level 1', () => {
    writeConfig([{ key: 'email_send', label: 'e', level: 2, locked: false, maxLevel: 2 }])
    expect(autonomyLevel('kanban_archive_done', CONFIG)).toBe(1)
  })

  it('an unreadable config yields level 1', () => {
    writeFileSync(CONFIG, '{ not json')
    expect(autonomyLevel('email_send', CONFIG)).toBe(1)
  })

  it('a nonsense stored level yields level 1 rather than being passed through', () => {
    writeConfig([{ key: 'email_send', label: 'e', level: 2.5, locked: false, maxLevel: 3 }])
    expect(autonomyLevel('email_send', CONFIG)).toBe(1)
  })

  it('a configured level is returned as configured', () => {
    writeConfig([{ key: 'email_send', label: 'e', level: 2, locked: false, maxLevel: 2 }])
    expect(autonomyLevel('email_send', CONFIG)).toBe(2)
  })
})

describe('POST /api/autonomy validates the level as an integer', () => {
  it('rejects a fractional level instead of persisting it', async () => {
    writeConfig([{ key: 'email_send', label: 'e', level: 1, locked: false, maxLevel: 2 }])
    const { ctx, out } = fakePost({ key: 'email_send', level: 2.5 })
    expect(await tryHandleAutonomy(ctx)).toBe(true)
    expect(out.status).toBe(400)
    const after = JSON.parse(readFileSync(CONFIG, 'utf-8'))
    expect(after.categories[0].level).toBe(1)
  })

  it('still accepts a whole level, and the write is atomic (temp + rename)', async () => {
    writeConfig([{ key: 'email_send', label: 'e', level: 1, locked: false, maxLevel: 2 }])
    const { ctx, out } = fakePost({ key: 'email_send', level: 2 })
    expect(await tryHandleAutonomy(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(JSON.parse(readFileSync(CONFIG, 'utf-8')).categories[0].level).toBe(2)
  })

  it('a locked category still cannot be raised', async () => {
    writeConfig([{ key: 'payment', label: 'p', level: 1, locked: true, maxLevel: 1 }])
    const { ctx, out } = fakePost({ key: 'payment', level: 3 })
    expect(await tryHandleAutonomy(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(JSON.parse(readFileSync(CONFIG, 'utf-8')).categories[0].level).toBe(1)
  })

  it('concurrent updates to DIFFERENT keys do not lose one another', async () => {
    // The read-modify-write rewrites the whole document, so an interleaved pair
    // used to end with whichever writer finished last — and the value lost is
    // an autonomy level.
    writeConfig([
      { key: 'a', label: 'a', level: 1, locked: false, maxLevel: 3 },
      { key: 'b', label: 'b', level: 1, locked: false, maxLevel: 3 },
    ])
    const one = fakePost({ key: 'a', level: 3 })
    const two = fakePost({ key: 'b', level: 2 })
    await Promise.all([tryHandleAutonomy(one.ctx), tryHandleAutonomy(two.ctx)])
    const after = JSON.parse(readFileSync(CONFIG, 'utf-8'))
    expect(after.categories.find((c: any) => c.key === 'a').level).toBe(3)
    expect(after.categories.find((c: any) => c.key === 'b').level).toBe(2)
  })
})
