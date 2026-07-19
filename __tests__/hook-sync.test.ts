/**
 * `margins workspace hook-sync` — the orchestrator both git hooks invoke (U6).
 *
 * The hook SCRIPTS are executed against real git repositories in
 * `install-hook.test.ts`. What is left here is what happens once the refs are in
 * hand: one tree read per object id, one branch write per ref, per-branch
 * serialization, independent per-branch failure (R17), and collapsed causes.
 * Those are decisions about ordering and error handling, not about git, so they
 * are exercised against the REAL `handlePush` with only the network boundary
 * (`casSync`, the api client) replaced — the same seam
 * `push-branch-flag.test.ts` uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../src/lib/config.js'
import type { CollectedSyncFiles } from '../src/lib/collect-sync-files.js'

const mockCasSync = vi.fn()
vi.mock('../src/lib/cas-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/cas-sync.js')>()),
  casSync: mockCasSync,
}))
vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({
    get: vi.fn(async () => ({ files: {}, headSha: null, contentMode: 'committed' })),
  }),
}))

// The collector is stubbed so a test can (a) count tree reads and (b) attach the
// rev as provenance, which is the only thing that survives into casSync's
// arguments and so the only way to tell WHICH commit a branch write carried.
const mockCollectForMode = vi.fn()
vi.mock('../src/lib/collect-sync-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/collect-sync-files.js')>()),
  collectForMode: mockCollectForMode,
  probeSyncSource: vi.fn(),
}))

function collected(rev: string | undefined): CollectedSyncFiles {
  return {
    files: [{ path: 'a.md', content: Buffer.from('# a\n'), contentType: 'text/markdown' }],
    mdCount: 1,
    mdPaths: ['a.md'],
    totalCount: 1,
    oversized: [],
    ...(rev ? { gitProvenance: { gitCommitSha: rev, gitObjectFormat: 'sha1' as const } } : {}),
  }
}

function makeConfig(): ResolvedConfig {
  return {
    serverUrl: 'https://margins.test',
    token: 'test-token',
    json: false,
    verbose: false,
  } as ResolvedConfig
}

/** casSync's arguments, decoded into (branch, rev-that-was-collected). */
function writes(): Array<{ branch: string; rev: string | undefined }> {
  return mockCasSync.mock.calls.map((c) => ({
    branch: c[2] as string,
    rev: (c[4] as { gitProvenance?: { gitCommitSha: string } })?.gitProvenance?.gitCommitSha,
  }))
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

let dataDir: string
let workDir: string
let prevDataDir: string | undefined

beforeEach(() => {
  vi.restoreAllMocks()
  mockCasSync.mockReset()
  mockCasSync.mockResolvedValue({ added: 0, changed: 0, deleted: 0, uploaded: 0, skipped: 0 })
  mockCollectForMode.mockReset()
  mockCollectForMode.mockImplementation((_dir: string, _mode: string, o: { rev?: string } = {}) =>
    collected(o.rev))
  // Per-branch locks live in the CLI's own data directory; isolate it so a test
  // run never touches (or waits on) the developer's real one.
  prevDataDir = process.env['MARGINS_DATA_DIR']
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-hook-data-'))
  process.env['MARGINS_DATA_DIR'] = dataDir
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-hook-work-'))
  fs.writeFileSync(
    path.join(workDir, '.margins.json'),
    JSON.stringify({ workspace_id: 'ws-1', syncMode: 'client' }),
  )
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  if (prevDataDir === undefined) delete process.env['MARGINS_DATA_DIR']
  else process.env['MARGINS_DATA_DIR'] = prevDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
})

function refLine(localBranch: string, sha: string, remoteRef: string, remoteSha = '0'.repeat(40)) {
  return `refs/heads/${localBranch} ${sha} ${remoteRef} ${remoteSha}`
}

describe('parsePrePushRefs', () => {
  it('takes the sha from the LOCAL object id and the branch from the REMOTE ref (R7)', async () => {
    const { parsePrePushRefs } = await import('../src/commands/workspace/push.js')
    expect(parsePrePushRefs(refLine('local-name', SHA_A, 'refs/heads/remote-name')))
      .toEqual([{ rev: SHA_A, branch: 'remote-name' }])
  })

  it('ignores tags and deletions (R7)', async () => {
    const { parsePrePushRefs } = await import('../src/commands/workspace/push.js')
    const input = [
      `refs/tags/v1 ${SHA_A} refs/tags/v1 ${'0'.repeat(40)}`,
      `(delete) ${'0'.repeat(40)} refs/heads/doomed ${SHA_B}`,
      refLine('keep', SHA_C, 'refs/heads/keep'),
    ].join('\n')
    expect(parsePrePushRefs(input)).toEqual([{ rev: SHA_C, branch: 'keep' }])
  })

  it('tolerates blank lines and an empty payload', async () => {
    const { parsePrePushRefs } = await import('../src/commands/workspace/push.js')
    expect(parsePrePushRefs('')).toEqual([])
    expect(parsePrePushRefs('\n\n')).toEqual([])
  })
})

describe('handleHookSync', () => {
  it('reads the tree once for two refs at one object id, but writes both branches', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    const results = await handleHookSync(makeConfig(), {
      event: 'pre-push',
      dir: workDir,
      refs: [
        refLine('main', SHA_A, 'refs/heads/main'),
        refLine('release', SHA_A, 'refs/heads/release'),
      ].join('\n'),
    })

    // One collection — the two refs name the same immutable tree.
    expect(mockCollectForMode).toHaveBeenCalledTimes(1)
    // Two branch writes — a shared commit does not make one branch update stand
    // in for the other.
    expect(writes()).toEqual([
      { branch: 'main', rev: SHA_A },
      { branch: 'release', rev: SHA_A },
    ])
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('keeps syncing after a branch fails, and records both outcomes (R17)', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    mockCasSync.mockImplementation(async (_c: unknown, _w: unknown, branch: string) => {
      if (branch === 'two') throw new Error('branch two exploded')
      return { added: 0, changed: 0, deleted: 0, uploaded: 0, skipped: 0 }
    })

    const results = await handleHookSync(makeConfig(), {
      event: 'pre-push',
      dir: workDir,
      refs: [
        refLine('one', SHA_A, 'refs/heads/one'),
        refLine('two', SHA_B, 'refs/heads/two'),
        refLine('three', SHA_C, 'refs/heads/three'),
      ].join('\n'),
    })

    expect(writes().map((w) => w.branch)).toEqual(['one', 'two', 'three'])
    expect(results).toEqual([
      { branch: 'one', rev: SHA_A, ok: true },
      { branch: 'two', rev: SHA_B, ok: false, error: 'branch two exploded' },
      { branch: 'three', rev: SHA_C, ok: true },
    ])
  })

  it('reports a cause shared by every branch once', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    mockCasSync.mockRejectedValue(new Error('workspace is in committed mode'))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await handleHookSync(makeConfig(), {
      event: 'pre-push',
      dir: workDir,
      refs: [
        refLine('one', SHA_A, 'refs/heads/one'),
        refLine('two', SHA_B, 'refs/heads/two'),
        refLine('three', SHA_C, 'refs/heads/three'),
      ].join('\n'),
    })

    const lines = stderr.mock.calls.map((c) => String(c[0])).join('')
    const occurrences = lines.split('workspace is in committed mode').length - 1
    expect(occurrences).toBe(1)
    // …while still naming every branch it applies to.
    for (const b of ['one', 'two', 'three']) expect(lines).toContain(b)
  })

  it('reports two distinct causes separately', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    mockCasSync.mockImplementation(async (_c: unknown, _w: unknown, branch: string) => {
      throw new Error(branch === 'one' ? 'cause A' : 'cause B')
    })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await handleHookSync(makeConfig(), {
      event: 'pre-push',
      dir: workDir,
      refs: [
        refLine('one', SHA_A, 'refs/heads/one'),
        refLine('two', SHA_B, 'refs/heads/two'),
      ].join('\n'),
    })

    const lines = stderr.mock.calls.map((c) => String(c[0])).join('')
    expect(lines).toContain('cause A')
    expect(lines).toContain('cause B')
  })

  it('serializes two syncs racing on one branch, so the older commit cannot land last', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    const finished: string[] = []
    let concurrent = 0
    let maxConcurrent = 0
    mockCasSync.mockImplementation(async (
      _c: unknown, _w: unknown, _b: unknown, _f: unknown,
      o: { gitProvenance?: { gitCommitSha: string } },
    ) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      const rev = o.gitProvenance!.gitCommitSha
      // The OLDER sync is the slow one. Without a per-branch lock the fast newer
      // sync completes first and the slow older one then lands on top, leaving
      // the branch pointing at the commit that came before.
      await new Promise((r) => setTimeout(r, rev === SHA_A ? 250 : 10))
      concurrent -= 1
      finished.push(rev)
      return { added: 0, changed: 0, deleted: 0, uploaded: 0, skipped: 0 }
    })

    const older = handleHookSync(makeConfig(), {
      event: 'pre-push', dir: workDir, refs: refLine('main', SHA_A, 'refs/heads/main'),
    })
    // Give the first sync time to take the lock, then start the second.
    await new Promise((r) => setTimeout(r, 30))
    const newer = handleHookSync(makeConfig(), {
      event: 'pre-push', dir: workDir, refs: refLine('main', SHA_B, 'refs/heads/main'),
    })
    await Promise.all([older, newer])

    expect(maxConcurrent).toBe(1)
    expect(finished).toEqual([SHA_A, SHA_B])
  })

  it('does not serialize syncs to DIFFERENT branches', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    let concurrent = 0
    let maxConcurrent = 0
    mockCasSync.mockImplementation(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 80))
      concurrent -= 1
      return { added: 0, changed: 0, deleted: 0, uploaded: 0, skipped: 0 }
    })

    await Promise.all([
      handleHookSync(makeConfig(), {
        event: 'pre-push', dir: workDir, refs: refLine('one', SHA_A, 'refs/heads/one'),
      }),
      handleHookSync(makeConfig(), {
        event: 'pre-push', dir: workDir, refs: refLine('two', SHA_B, 'refs/heads/two'),
      }),
    ])

    expect(maxConcurrent).toBe(2)
  })

  it('releases the branch lock when a sync throws', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    mockCasSync.mockRejectedValueOnce(new Error('boom'))
    await handleHookSync(makeConfig(), {
      event: 'pre-push', dir: workDir, refs: refLine('main', SHA_A, 'refs/heads/main'),
    })
    // A lock the failure path leaked would make this second sync wait out the
    // full stale timeout instead of running.
    const results = await handleHookSync(makeConfig(), {
      event: 'pre-push', dir: workDir, refs: refLine('main', SHA_B, 'refs/heads/main'),
    })
    expect(results).toEqual([{ branch: 'main', rev: SHA_B, ok: true }])
  })

  it('syncs the named commit to the named branch for a post-commit event (R6)', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    const results = await handleHookSync(makeConfig(), {
      event: 'post-commit', dir: workDir, rev: SHA_A, branch: 'feature-x',
    })
    expect(mockCollectForMode).toHaveBeenCalledWith(workDir, 'committed', { rev: SHA_A })
    expect(writes()).toEqual([{ branch: 'feature-x', rev: SHA_A }])
    expect(results).toEqual([{ branch: 'feature-x', rev: SHA_A, ok: true }])
  })

  it('falls back to git branch detection when post-commit HEAD is detached', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    // The hook passes an empty --branch on a detached HEAD (`symbolic-ref -q`
    // prints nothing). Passing "" through would push to a branch named "".
    await handleHookSync(makeConfig(), {
      event: 'post-commit', dir: workDir, rev: SHA_A, branch: '',
    })
    expect(writes()[0]!.branch).not.toBe('')
    expect(writes()[0]!.branch).toBeTruthy()
  })

  it('does nothing at all for a tags-only push', async () => {
    const { handleHookSync } = await import('../src/commands/workspace/push.js')
    const results = await handleHookSync(makeConfig(), {
      event: 'pre-push', dir: workDir,
      refs: `refs/tags/v1 ${SHA_A} refs/tags/v1 ${'0'.repeat(40)}`,
    })
    expect(results).toEqual([])
    expect(mockCollectForMode).not.toHaveBeenCalled()
    expect(mockCasSync).not.toHaveBeenCalled()
  })
})
