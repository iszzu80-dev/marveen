import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLiveStore, mayMutate, liveStorePaths, LIVE_APPLY_FLAG } from '../cos/live-store-guard.js'

// The guard that would have stopped the 2026-09-06 live mutation. Every case
// below exists because the guard has to be able to say NO -- a guard only ever
// observed saying yes is a guard nobody has tested.

describe('live store guard', () => {
  let dir: string
  let live: string
  let clone: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guard-'))
    live = join(dir, 'store', 'claudeclaw.db')
    clone = join(dir, 'clone.db')
    mkdirSync(join(dir, 'store'), { recursive: true })
    writeFileSync(live, 'live')
    writeFileSync(clone, 'clone')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('RED: refuses --apply against the live store', () => {
    const v = mayMutate(live, ['--apply'], true, [live])
    expect(v.allowed).toBe(false)
    expect(v.live).toBe(true)
    expect(v.reason).toContain('LIVE store')
  })

  it('GREEN: allows --apply against a clone', () => {
    const v = mayMutate(clone, ['--apply'], true, [live])
    expect(v.allowed).toBe(true)
    expect(v.live).toBe(false)
  })

  it('a read-only run against the live store is fine', () => {
    // The seam exists to make dry runs easy. Refusing those would push people
    // back to editing the script, which is how the hardcoded path survived.
    expect(mayMutate(live, [], false, [live]).allowed).toBe(true)
  })

  it('the owner GO on argv lifts the refusal, and ONLY that flag does', () => {
    expect(mayMutate(live, ['--apply', LIVE_APPLY_FLAG], true, [live]).allowed).toBe(true)
    expect(mayMutate(live, ['--apply', '--approved'], true, [live]).allowed).toBe(false)
    expect(mayMutate(live, ['--apply', '--force'], true, [live]).allowed).toBe(false)
    expect(mayMutate(live, ['--apply', '--yes'], true, [live]).allowed).toBe(false)
  })

  it('A SYMLINK TO THE LIVE STORE IS THE LIVE STORE', () => {
    // The obvious dodge, and it would have looked like a clone in every log
    // line. Paths are compared after realpath, not as strings.
    const sneaky = join(dir, 'totally-a-clone.db')
    symlinkSync(live, sneaky)
    expect(isLiveStore(sneaky, [live])).toBe(true)
    expect(mayMutate(sneaky, ['--apply'], true, [live]).allowed).toBe(false)
  })

  it('a relative path naming the same file is the live store', () => {
    const viaDots = join(dir, 'store', '..', 'store', 'claudeclaw.db')
    expect(isLiveStore(viaDots, [live])).toBe(true)
  })

  it('FAILS CLOSED: a target that cannot be resolved is treated as live', () => {
    // Not "assume it is fine because we could not check". The default has to be
    // the one that stops, and the only way to prove that is to ask.
    expect(isLiveStore(live, [live])).toBe(true)
    // A nonexistent path that still resolves to the same absolute location.
    const gone = join(dir, 'store', 'claudeclaw.db')
    rmSync(gone)
    expect(isLiveStore(gone, [gone])).toBe(true)
    expect(mayMutate(gone, ['--apply'], true, [gone]).allowed).toBe(false)
  })

  it('names the resolved target, so a log says WHICH database was written', () => {
    const v = mayMutate(clone, ['--apply'], true, [live])
    expect(v.target).toContain('clone.db')
    expect(v.target.startsWith('/')).toBe(true)
  })

  it('THE DEFAULT HINTS INCLUDE THE HOME INSTALL, not just a cwd-relative path', () => {
    // The bug this case exists for: the first version compared against
    // `store/claudeclaw.db` resolved from the WORKING DIRECTORY. Run the script
    // from a worktree and that names the worktree's store, so a MARVEEN_DB
    // pointing at the real install resolved to "not live" and the guard waved
    // the mutation through -- fail-open, in the one function whose whole job is
    // to fail closed. Every case above injects its own hints and none of them
    // could have seen it.
    const paths = liveStorePaths()
    expect(paths).toContain(join(process.env.HOME ?? '', 'marveen', 'store', 'claudeclaw.db'))
    expect(paths.length).toBeGreaterThan(1)
    // Named from ANY directory, the home install is still the live store.
    expect(isLiveStore(join(process.env.HOME ?? '', 'marveen', 'store', 'claudeclaw.db'))).toBe(true)
    expect(mayMutate(join(process.env.HOME ?? '', 'marveen', 'store', 'claudeclaw.db'), ['--apply'], true).allowed)
      .toBe(false)
  })
})
