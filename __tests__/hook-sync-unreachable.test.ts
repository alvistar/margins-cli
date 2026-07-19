/**
 * The hook orchestrator against an unreachable server, through the REAL
 * `resolveSyncMode` (R17).
 *
 * `hook-sync.test.ts` stubs sync-mode resolution so it can pose one branch as a
 * server-sync workspace. That stub also hides the thing this file is for: the
 * resolver's own unreachable-server branch, reached only by a legacy
 * `{ mode: "overlay" }` `.margins.json` — still a supported READ format — and
 * only when the question it must ask the server goes unanswered.
 *
 * That branch used to `process.exit(1)`. Two separate consequences, both real,
 * and neither visible from inside the resolver:
 *
 *   1. it kills the whole background process, so every branch queued behind the
 *      failing one silently never syncs and no failure is recorded for any of
 *      them — the exact thing R17 forbids;
 *   2. `process.exit` does not run pending `finally` blocks, so the per-branch
 *      lock directory `withBranchLock` took is never removed. The next sync of
 *      that branch then waits out the full stale-lock timeout.
 *
 * So only the network boundary is replaced here. The resolver, the push handler,
 * the branch loop and the lock are all the real ones, because the bug lived in
 * how they compose rather than in any one of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../src/lib/config.js'

const mockCasSync = vi.fn()
vi.mock('../src/lib/cas-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/cas-sync.js')>()),
  casSync: mockCasSync,
}))

// The ONLY seam. Two GETs matter and they are different requests:
//   `/api/workspaces/<id>`          — the resolver's legacy-overlay question
//   `/api/workspaces/<id>/sync/...` — the push's manifest preflight
const mockGet = vi.fn()
vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({ get: mockGet }),
}))

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

let dataDir: string
let workDir: string
let prevDataDir: string | undefined

/** The lock directory `withBranchLock` uses, resolved under the test's data dir. */
async function lockDirEntries(): Promise<string[]> {
  const { registryPath } = await import('../src/lib/registry.js')
  const locks = path.join(path.dirname(registryPath()), 'hook-locks')
  return fs.existsSync(locks) ? fs.readdirSync(locks) : []
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockCasSync.mockReset()
  mockCasSync.mockResolvedValue({ added: 0, changed: 0, deleted: 0, uploaded: 0, skipped: 0 })
  mockGet.mockReset()

  prevDataDir = process.env['MARGINS_DATA_DIR']
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-unreach-data-'))
  process.env['MARGINS_DATA_DIR'] = dataDir
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-unreach-work-'))

  // The legacy form: no `syncMode`, so the mode can only be settled by asking.
  fs.writeFileSync(
    path.join(workDir, '.margins.json'),
    JSON.stringify({ workspace_id: 'ws-1', mode: 'overlay' }),
  )
  fs.writeFileSync(path.join(workDir, 'a.md'), '# a\n')

  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  if (prevDataDir === undefined) delete process.env['MARGINS_DATA_DIR']
  else process.env['MARGINS_DATA_DIR'] = prevDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
})

function makeConfig(): ResolvedConfig {
  // Built to the real shape rather than cast into it: the api client is stubbed
  // here anyway, so a cast would buy nothing except a type error.
  return {
    apiKey: 'mrgn_test',
    serverUrl: 'https://margins.test',
    json: false,
    verbose: false,
    noColor: true,
  }
}

function refLine(branch: string, sha: string) {
  return `refs/heads/${branch} ${sha} refs/heads/${branch} ${'0'.repeat(40)}`
}

describe('handleHookSync — the resolver cannot reach the server', () => {
  it('records the branch it hit and still syncs the rest, without exiting or leaking a lock (R17)', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')

    // The first legacy-overlay question goes unanswered; the server comes back
    // for the ones after it. (The resolver rewrites `.margins.json` in place on
    // a successful answer, so the unreachable window has to open on the first
    // branch to still be open when that branch is reached.)
    let overlayAsks = 0
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/manifest')) {
        return { files: {}, headSha: null, contentMode: 'working-tree' }
      }
      overlayAsks += 1
      if (overlayAsks === 1) throw new Error('ECONNREFUSED 127.0.0.1:443')
      return { syncMode: 'client' }
    })

    // A no-op spy would let the code run on past the exit and hide the very
    // termination under test — so this one terminates, loudly.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit called — the background process would have died here')
    }) as never)

    const results = await handleHookSync(makeConfig(), {
      event: 'pre-push',
      dir: workDir,
      refs: [
        refLine('one', SHA_A),
        refLine('two', SHA_B),
        refLine('three', SHA_C),
      ].join('\n'),
    })

    // (1) Nothing terminated the process…
    expect(exit).not.toHaveBeenCalled()

    // (2) …the branches behind the failing one still went out…
    expect(results.map((r) => ({ branch: r.branch, ok: r.ok }))).toEqual([
      { branch: 'one', ok: false },
      { branch: 'two', ok: true },
      { branch: 'three', ok: true },
    ])
    expect(mockCasSync.mock.calls.map((c) => c[2])).toEqual(['two', 'three'])

    // (3) …the failure is recorded as its own, with the resolver's wording…
    expect(results[0]!.error).toMatch(/Cannot determine sync mode/)

    // (4) …and every lock taken was released. `process.exit` skips `finally`,
    // so a leaked lock is the fingerprint of a termination that happened
    // somewhere inside the loop.
    expect(await lockDirEntries()).toEqual([])
  })

  it('settles that outcome into a findable record rather than silence', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    const { settleHookSyncOutcome, readSyncFailureRecords } =
      await import('../src/lib/sync-failure-record.js')

    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/manifest')) {
        return { files: {}, headSha: null, contentMode: 'working-tree' }
      }
      throw new Error('ECONNREFUSED 127.0.0.1:443')
    })

    const results = await handleHookSync(makeConfig(), {
      event: 'pre-push', dir: workDir, refs: refLine('main', SHA_A),
    })
    settleHookSyncOutcome(workDir, results, { env: {} })

    const records = readSyncFailureRecords()
    expect(records).toHaveLength(1)
    expect(records[0]!.branches).toEqual(['main'])
    expect(records[0]!.cause).toMatch(/Cannot determine sync mode/)
  })
})
