/**
 * `resolveSyncMode` — reading a workspace's sync mode, including the legacy
 * `{ mode: "overlay" }` form that can only be settled by asking the server.
 *
 * The property under test here is NOT the happy path (covered wherever push is
 * exercised end to end) but the failure path: what happens when that server
 * question cannot be answered.
 *
 * It used to `console.error` + `process.exit(1)`. That is right for a human at a
 * terminal and wrong for every other caller — and there IS another caller: the
 * background hook orchestrator reaches this function once per branch, through
 * `handleHookSync` → `handlePush`. A `process.exit` there does not refuse ONE
 * branch, it kills the whole process, so the branches queued behind it never
 * sync, nothing is recorded for any of them (R17), and — because `process.exit`
 * skips pending `finally` blocks — the per-branch lock directory is never
 * removed, blocking future syncs of that branch until the stale-lock timeout.
 *
 * So it throws. The top-level CLI handler turns the throw back into the same
 * message on stderr and the same non-zero exit for the human case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveSyncMode } from '../src/lib/resolve-sync-mode.js'
import type { LocalConfig } from '../src/lib/config.js'
import type { ApiClient } from '../src/lib/api-client.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A client whose every GET fails, standing in for an unreachable server. */
function unreachableClient(): ApiClient {
  return {
    get: vi.fn(async () => { throw new Error('ECONNREFUSED') }),
  } as unknown as ApiClient
}

function client(syncMode: 'server' | 'client'): ApiClient {
  return { get: vi.fn(async () => ({ syncMode })) } as unknown as ApiClient
}

/**
 * A `process.exit` spy that TERMINATES the flow rather than returning.
 *
 * A no-op spy would let execution fall through past the exit and hide exactly
 * the bug this file exists to pin: the real `process.exit` never returns.
 */
function exitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('process.exit called — the background process would have died here')
  }) as never)
}

describe('resolveSyncMode — the settled cases', () => {
  it('returns an explicit syncMode without asking the server', async () => {
    const c = client('server')
    expect(await resolveSyncMode({ syncMode: 'push' } as LocalConfig, c)).toBe('push')
    expect(await resolveSyncMode({ syncMode: 'pull' } as LocalConfig, c)).toBe('pull')
    expect(c.get).not.toHaveBeenCalled()
  })

  it('reads the deprecated "client"/"server" as push/pull', async () => {
    const c = client('server')
    expect(await resolveSyncMode({ syncMode: 'client' } as LocalConfig, c, '/nonexistent-dir')).toBe('push')
    expect(await resolveSyncMode({ syncMode: 'server' } as LocalConfig, c, '/nonexistent-dir')).toBe('pull')
    expect(c.get).not.toHaveBeenCalled()
  })

  it('treats legacy mode:"local" as push, and an unknown shape as push', async () => {
    const c = unreachableClient()
    expect(await resolveSyncMode({ mode: 'local' } as LocalConfig, c)).toBe('push')
    expect(await resolveSyncMode({} as LocalConfig, c)).toBe('push')
    expect(c.get).not.toHaveBeenCalled()
  })
})

describe('resolveSyncMode — legacy overlay against an unreachable server', () => {
  it('THROWS rather than exiting the process (R17)', async () => {
    const exit = exitSpy()
    const legacy = { mode: 'overlay', workspace_id: 'ws-1' } as LocalConfig

    await expect(resolveSyncMode(legacy, unreachableClient()))
      .rejects.toThrow(/Cannot determine sync mode/)

    // The whole point: a caller above this one gets to decide what the failure
    // means. `process.exit` takes that decision away from every one of them.
    expect(exit).not.toHaveBeenCalled()
  })

  it('keeps the remedy in the message a human will read', async () => {
    exitSpy()
    const legacy = { mode: 'overlay', workspace_id: 'ws-1' } as LocalConfig
    await expect(resolveSyncMode(legacy, unreachableClient()))
      .rejects.toThrow(/"syncMode": "push"/)
  })
})

// ─── The detail read (ai-review#282, user story 33) ───────────────────────────
//
// `GET /api/workspaces/:id` answers `{ workspace: { syncMode }, tree, ... }`.
// Reading `syncMode` off the top level found nothing and defaulted to client —
// so a workspace that pulls from GitHub was read as one that takes pushes.

describe('resolveSyncMode — the detail endpoint read', () => {
  const nested = (syncMode: unknown): ApiClient =>
    ({ get: vi.fn(async () => ({ workspace: { id: 'ws-1', syncMode }, tree: [] })) }) as unknown as ApiClient
  const legacy = { mode: 'overlay', workspace_id: 'ws-1' } as LocalConfig

  it('reads syncMode from the nested workspace object', async () => {
    expect(await resolveSyncMode(legacy, nested('server'), '/nonexistent-dir')).toBe('pull')
    expect(await resolveSyncMode(legacy, nested('client'), '/nonexistent-dir')).toBe('push')
  })

  it('a missing value is NOT read as push', async () => {
    await expect(resolveSyncMode(legacy, nested(undefined)))
      .rejects.toThrow(/did not report one/)
    const empty = { get: vi.fn(async () => ({ workspace: { id: 'ws-1' } })) } as unknown as ApiClient
    await expect(resolveSyncMode(legacy, empty)).rejects.toThrow(/did not report one/)
  })

  it('an unknown value is NOT read as push', async () => {
    await expect(resolveSyncMode(legacy, nested('sideways'))).rejects.toThrow(/did not report one/)
  })
})

describe('resolveSyncMode — a file that says "pull" after the switch to push', () => {
  it('asks the server, and a switched workspace is push (first push not refused)', async () => {
    const c = { get: vi.fn(async () => ({ workspace: { syncMode: 'client' } })) } as unknown as ApiClient
    const cfg = { syncMode: 'pull', workspace_id: 'ws-1' } as LocalConfig
    expect(await resolveSyncMode(cfg, c, '/nonexistent-dir')).toBe('push')
    expect(c.get).toHaveBeenCalledWith('/api/workspaces/ws-1')
  })

  it('keeps "pull" when the server still says so, says nothing, or cannot be reached', async () => {
    const cfg = { syncMode: 'pull', workspace_id: 'ws-1' } as LocalConfig
    const still = { get: vi.fn(async () => ({ workspace: { syncMode: 'server' } })) } as unknown as ApiClient
    const silent = { get: vi.fn(async () => ({ workspace: {} })) } as unknown as ApiClient
    expect(await resolveSyncMode(cfg, still)).toBe('pull')
    expect(await resolveSyncMode(cfg, silent)).toBe('pull')
    expect(await resolveSyncMode(cfg, unreachableClient())).toBe('pull')
  })
})

describe('resolveSyncMode — switch edges', () => {
  it('reads the flat { syncMode } shape too (fetchWorkspaceSyncMode fallback)', async () => {
    const legacy = { mode: 'overlay', workspace_id: 'ws-1' } as LocalConfig
    expect(await resolveSyncMode(legacy, client('server'), '/nonexistent-dir')).toBe('pull')
    expect(await resolveSyncMode(legacy, client('client'), '/nonexistent-dir')).toBe('push')
  })

  it('"pull" with no workspace_id is kept without asking the server', async () => {
    const c = unreachableClient()
    expect(await resolveSyncMode({ syncMode: 'pull' } as LocalConfig, c)).toBe('pull')
    expect(c.get).not.toHaveBeenCalled()
  })

  it('a switched workspace upgrades .margins.json to "push" in place', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-rsm-'))
    try {
      const file = path.join(dir, '.margins.json')
      fs.writeFileSync(file, JSON.stringify({ workspace_id: 'ws-1', syncMode: 'pull', extra: 1 }))
      const cfg = { syncMode: 'pull', workspace_id: 'ws-1' } as LocalConfig
      const c = { get: vi.fn(async () => ({ workspace: { syncMode: 'client' } })) } as unknown as ApiClient
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveSyncMode(cfg, c, dir)).toBe('push')
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ workspace_id: 'ws-1', syncMode: 'push', extra: 1 })
      // A committed file just changed: the user is told, not left with a surprise diff.
      expect(err.mock.calls.join('\n')).toMatch(/Updated the file to "syncMode": "push" — commit it\./)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a deprecated "server" file of a switched workspace is rewritten once, to "push", with one line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-rsm-'))
    try {
      const file = path.join(dir, '.margins.json')
      fs.writeFileSync(file, JSON.stringify({ workspace_id: 'ws-1', syncMode: 'server' }))
      const cfg = { syncMode: 'server', workspace_id: 'ws-1' } as LocalConfig
      const c = { get: vi.fn(async () => ({ workspace: { syncMode: 'client' } })) } as unknown as ApiClient
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveSyncMode(cfg, c, dir)).toBe('push')
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).syncMode).toBe('push')
      expect(err).toHaveBeenCalledTimes(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a deprecated alias that still holds is rewritten to the new word, with the alias line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-rsm-'))
    try {
      const file = path.join(dir, '.margins.json')
      fs.writeFileSync(file, JSON.stringify({ workspace_id: 'ws-1', syncMode: 'server' }))
      const cfg = { syncMode: 'server', workspace_id: 'ws-1' } as LocalConfig
      const still = { get: vi.fn(async () => ({ workspace: { syncMode: 'server' } })) } as unknown as ApiClient
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await resolveSyncMode(cfg, still, dir)).toBe('pull')
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).syncMode).toBe('pull')
      expect(err.mock.calls.map((c) => c[0])).toEqual([
        'Updated .margins.json: "syncMode": "server" → "pull" — commit it.',
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a legacy overlay file is upgraded to the new words', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-rsm-'))
    try {
      const file = path.join(dir, '.margins.json')
      fs.writeFileSync(file, JSON.stringify({ workspace_id: 'ws-1', mode: 'overlay' }))
      const legacy = { mode: 'overlay', workspace_id: 'ws-1' } as LocalConfig
      expect(await resolveSyncMode(legacy, client('server'), dir)).toBe('pull')
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).syncMode).toBe('pull')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
