import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../../src/lib/config.js'

/**
 * The empty-collection contract, and the full-delete guard it makes reachable.
 *
 * Before U4 the two callers disagreed: `workspace push` threw locally on an
 * empty collection and `margins sync` skipped the push and reported success. So
 * NEITHER reached `casSync`'s full-delete guard — it was dead code in
 * production, and R8's promise that the CLI says why nothing was sent was
 * unsatisfiable on the `sync` path.
 *
 * U4 removes both early exits, which puts that guard on the live path for the
 * first time. These tests exist to prove it fires, that `--confirm-full-delete`
 * is the only way past it, and that both callers say the same thing — byte for
 * byte — when a collection comes back empty.
 */

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPutRaw = vi.fn()

vi.mock('../../src/lib/api-client.js', () => ({
  createApiClient: () => ({ get: mockGet, post: mockPost, putRaw: mockPutRaw }),
}))

const makeConfig = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  serverUrl: 'https://margins.test',
  apiKey: 'mrgn_testkey123',
  json: false,
  verbose: false,
  noColor: false,
  ...overrides,
} as ResolvedConfig)

const sha = (s: string): string => createHash('sha256').update(Buffer.from(s)).digest('hex')

/** A populated server branch — the state the full-delete guard protects. */
const POPULATED = { files: { 'existing.md': sha('# Existing\n') }, headSha: 'head-1' }

let tmpDir: string
let dataDir: string
let logSpy: ReturnType<typeof vi.spyOn>
let stderrChunks: string[]

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockPutRaw.mockReset()
  mockPost.mockResolvedValue({})
  mockPutRaw.mockResolvedValue({})
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-empty-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-empty-data-'))
  vi.stubEnv('MARGINS_DATA_DIR', dataDir)
  // The probe requires a git repo OR markdown on disk; these tests are all
  // "a real checkout that currently holds no markdown".
  execFileSync('git', ['init', '-q'], { cwd: tmpDir, stdio: 'ignore' })
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  stderrChunks = []
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrChunks.push(String(chunk))
    return true
  }) as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** `.margins.json` that sends handleSync straight to the push. */
function writeMarginsJson(): void {
  fs.writeFileSync(
    path.join(tmpDir, '.margins.json'),
    JSON.stringify({
      workspace_id: 'ws-1',
      workspace_slug: 'gh/x/y',
      default_branch: 'main',
      syncMode: 'client',
    }),
  )
}

const pushCaller = async (opts: { confirmFullDelete?: boolean } = {}): Promise<void> => {
  const { handlePush } = await import('../../src/commands/workspace/push.js')
  await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main', ...opts })
}

const syncCaller = async (opts: { confirmFullDelete?: boolean } = {}): Promise<void> => {
  writeMarginsJson()
  const { handleSync } = await import('../../src/commands/sync.js')
  await handleSync(makeConfig(), { dir: tmpDir, ...opts })
}

// ─── The guard, now reachable from both callers ──────────────────────────────

describe.each([
  ['workspace push', pushCaller],
  ['sync', syncCaller],
])('%s — an empty collection against a populated branch', (_name, run) => {
  it('reaches the full-delete guard and is refused, sending nothing destructive', async () => {
    const { FullDeleteNotConfirmedError } = await import('../../src/lib/errors.js')
    mockGet.mockResolvedValue(POPULATED)

    let caught: unknown
    await run().catch((e: unknown) => { caught = e })

    expect(caught).toBeInstanceOf(FullDeleteNotConfirmedError)
    expect((caught as InstanceType<typeof FullDeleteNotConfirmedError>).userMessage)
      .toMatch(/--confirm-full-delete/)

    // The guard fires before any write leaves the machine.
    expect(mockPutRaw).not.toHaveBeenCalled()
    expect(mockPost.mock.calls.filter((c) => String(c[0]).includes('/sync/manifest')))
      .toHaveLength(0)
  })

  it('proceeds past the guard to the manifest POST with --confirm-full-delete', async () => {
    mockGet.mockResolvedValue(POPULATED)

    await run({ confirmFullDelete: true })

    const manifestPost = mockPost.mock.calls.find((c) => String(c[0]).includes('/sync/manifest'))
    expect(manifestPost).toBeDefined()
    const body = manifestPost![1] as { files: Record<string, string>; confirmFullDelete?: boolean }
    expect(body.files).toEqual({})
    expect(body.confirmFullDelete).toBe(true)
  })

  it('still states why nothing was collected (R8)', async () => {
    mockGet.mockResolvedValue(POPULATED)

    await run().catch(() => { /* the guard's refusal is asserted above */ })

    expect(stderrChunks.join('')).toContain(`Nothing to send: no .md files found in ${tmpDir}.`)
  })
})

// ─── The two callers say the same thing, byte for byte ───────────────────────

describe('the empty-collection message is byte-identical across callers (R8)', () => {
  /** Capture the exact stderr line each caller emits for the same empty dir. */
  async function captureNotice(run: () => Promise<void>): Promise<string> {
    stderrChunks.length = 0
    mockGet.mockResolvedValue({ files: {}, headSha: null }) // empty branch: no guard
    await run()
    const line = stderrChunks.find((c) => c.startsWith('Nothing to send'))
    if (line === undefined) {
      throw new Error(`no empty-collection notice emitted; stderr was ${JSON.stringify(stderrChunks)}`)
    }
    return line
  }

  it('emits the identical string from `workspace push` and from `sync`', async () => {
    const fromPush = await captureNotice(() => pushCaller())
    const fromSync = await captureNotice(() => syncCaller())

    expect(fromPush).toBe(fromSync)
    expect(fromPush).toBe(`Nothing to send: no .md files found in ${tmpDir}.\n`)
  })
})

// ─── `sync` no longer reports a silent success ───────────────────────────────

describe('handleSync — an empty collection is no longer a silent success', () => {
  it('posts the (empty) manifest instead of skipping the push entirely', async () => {
    mockGet.mockResolvedValue({ files: {}, headSha: null })

    await syncCaller()

    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/sync/manifest'))).toBe(true)
  })
})
