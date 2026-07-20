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
    expect(await resolveSyncMode({ syncMode: 'client' } as LocalConfig, c)).toBe('client')
    expect(await resolveSyncMode({ syncMode: 'server' } as LocalConfig, c)).toBe('server')
    expect(c.get).not.toHaveBeenCalled()
  })

  it('treats legacy mode:"local" as client, and an unknown shape as client', async () => {
    const c = unreachableClient()
    expect(await resolveSyncMode({ mode: 'local' } as LocalConfig, c)).toBe('client')
    expect(await resolveSyncMode({} as LocalConfig, c)).toBe('client')
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
      .rejects.toThrow(/"syncMode": "client"/)
  })
})
