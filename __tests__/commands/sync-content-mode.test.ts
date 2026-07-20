import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../../src/lib/config.js'

/**
 * `margins sync` and the content mode (R2, R4, KTD1).
 *
 * The mode is a workspace setting delivered by the preflight and NEVER cached
 * locally — so the first sync of a git repository has to ask, and send the
 * answer to the server rather than writing it into `.margins.json`. A session
 * that cannot ask must be told to state the choice, not guess one.
 */

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPut = vi.fn()
const mockPutRaw = vi.fn()

vi.mock('../../src/lib/api-client.js', () => ({
  createApiClient: () => ({ get: mockGet, post: mockPost, put: mockPut, putRaw: mockPutRaw }),
}))

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }))

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  select: mockSelect,
}))

const makeConfig = (json = false): ResolvedConfig => ({
  serverUrl: 'https://margins.test',
  apiKey: 'mrgn_testkey123',
  json,
  verbose: false,
  noColor: false,
} as ResolvedConfig)

let tmpDir: string
let dataDir: string
let originalIsTTY: unknown

/** `process.stdin.isTTY` is a plain property, not a getter — define it. */
function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockPut.mockReset()
  mockPut.mockResolvedValue({})
  mockPutRaw.mockReset()
  mockSelect.mockReset()
  mockPutRaw.mockResolvedValue({})
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-mode-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-mode-data-'))
  vi.stubEnv('MARGINS_DATA_DIR', dataDir)
  originalIsTTY = process.stdin.isTTY
  execFileSync('git', ['init', '-q'], { cwd: tmpDir, stdio: 'ignore' })
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hi\n')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Every set-mode call, whichever verb it went out on. Checking only one verb
 * would let a regression that switches methods pass vacuously — which is how
 * the POST-vs-PUT drift against the server went unnoticed in the first place.
 */
function setModeCalls(): unknown[][] {
  return [...mockPut.mock.calls, ...mockPost.mock.calls]
    .filter((c) => String(c[0]).endsWith('/content-mode'))
}

/** Answer the workspace-create POST, then everything else. */
function routePosts(): void {
  mockPost.mockImplementation(async (p: string) => {
    if (p === '/api/workspaces') return { workspace: { id: 'ws-new', slug: 'local/u/x' } }
    return {}
  })
}

const runSync = async (opts: Record<string, unknown> = {}, json = false): Promise<void> => {
  const { handleSync } = await import('../../src/commands/sync.js')
  await handleSync(makeConfig(json), { dir: tmpDir, ...opts })
}

describe('handleSync — first sync of a git repository (R2)', () => {
  it('asks which mode to use and sends the answer to the server', async () => {
    routePosts()
    mockGet.mockResolvedValue({ files: {}, headSha: null, contentMode: 'working-tree' })
    mockSelect.mockResolvedValue('committed')
    setTTY(true)

    // The committed collector is U5's; this run only has to get as far as
    // choosing it and telling the server.
    await runSync().catch(() => { /* committed collection is not implemented yet */ })

    expect(mockSelect).toHaveBeenCalledTimes(1)
    // PUT, and `hasGitRepo` — pinned to the server's committed contract. The
    // route exports only PUT (a POST is a 405), and it fails closed unless
    // `hasGitRepo === true`, so `hasGit` would be refused as "no git
    // repository" from inside a git repository.
    const setMode = mockPut.mock.calls.find((c) => String(c[0]).endsWith('/content-mode'))
    expect(setMode).toBeDefined()
    expect(setMode![0]).toBe('/api/workspaces/ws-new/content-mode')
    expect(setMode![1]).toEqual({
      mode: 'committed', expectedMode: 'working-tree', hasGitRepo: true,
    })
    expect(
      mockPost.mock.calls.some((c) => String(c[0]).endsWith('/content-mode')),
      'the set-mode call must not go out as a POST — the route is PUT-only',
    ).toBe(false)
  })

  it('errors rather than defaulting when the session is not interactive and no mode was stated', async () => {
    routePosts()
    mockGet.mockResolvedValue({ files: {}, headSha: null, contentMode: 'working-tree' })
    setTTY(false)

    await expect(runSync()).rejects.toThrow(/not interactive/)

    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockPutRaw).not.toHaveBeenCalled()
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/sync/manifest'))).toBe(false)
  })

  it('accepts an explicit --content-mode in a non-interactive session, without prompting', async () => {
    routePosts()
    mockGet.mockResolvedValue({ files: {}, headSha: null, contentMode: 'working-tree' })
    setTTY(false)

    await runSync({ contentMode: 'working-tree' })

    expect(mockSelect).not.toHaveBeenCalled()
    // Already the workspace's mode — no set-mode write is issued.
    expect(setModeCalls(), 'no set-mode call should be issued on this path').toEqual([])
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/sync/manifest'))).toBe(true)
  })

  it('does not prompt when the server reports no mode at all (it predates the feature)', async () => {
    routePosts()
    mockGet.mockResolvedValue({ files: {}, headSha: null }) // no contentMode field
    setTTY(true)

    await runSync()

    expect(mockSelect).not.toHaveBeenCalled()
    expect(setModeCalls(), 'no set-mode call should be issued on this path').toEqual([])
    expect(mockPutRaw.mock.calls[0]![3]).toEqual({ 'X-Margins-Content-Mode': 'working-tree' })
  })

  it('writes no content mode into .margins.json', async () => {
    routePosts()
    mockGet.mockResolvedValue({ files: {}, headSha: null, contentMode: 'working-tree' })
    setTTY(true)
    mockSelect.mockResolvedValue('working-tree')

    await runSync()

    const raw = fs.readFileSync(path.join(tmpDir, '.margins.json'), 'utf-8')
    expect(raw).not.toMatch(/content|working-tree|committed/i)
  })
})

describe('handleSync — an already-configured workspace', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(tmpDir, '.margins.json'),
      JSON.stringify({
        workspace_id: 'ws-1', workspace_slug: 'gh/x/y', default_branch: 'main', syncMode: 'client',
      }),
    )
  })

  it('never prompts — the workspace already has a mode, and the preflight delivers it', async () => {
    mockPost.mockResolvedValue({})
    mockGet.mockResolvedValue({ files: {}, headSha: null, contentMode: 'working-tree' })
    setTTY(true)

    await runSync()

    expect(mockSelect).not.toHaveBeenCalled()
    expect(setModeCalls(), 'no set-mode call should be issued on this path').toEqual([])
  })

  it('refuses a --content-mode that contradicts the workspace, before collecting (R5)', async () => {
    mockPost.mockResolvedValue({})
    mockGet.mockResolvedValue({ files: {}, headSha: null, contentMode: 'working-tree' })

    await expect(runSync({ contentMode: 'committed' })).rejects.toThrow(/contradicts this workspace/)

    expect(mockPutRaw).not.toHaveBeenCalled()
    expect(mockPost.mock.calls.some((c) => String(c[0]).includes('/sync/manifest'))).toBe(false)
  })

  it('declares the collected mode on the manifest POST and every blob upload', async () => {
    mockPost.mockResolvedValue({})
    mockGet.mockResolvedValue({ files: {}, headSha: null, contentMode: 'working-tree' })

    await runSync()

    const manifestPost = mockPost.mock.calls.find((c) => String(c[0]).includes('/sync/manifest'))
    expect(manifestPost![2]).toEqual({ 'X-Margins-Content-Mode': 'working-tree' })
    expect(mockPutRaw).toHaveBeenCalledTimes(1)
    expect(mockPutRaw.mock.calls[0]![3]).toEqual({ 'X-Margins-Content-Mode': 'working-tree' })
  })
})
