import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../../src/lib/config.js'

/**
 * Regression: `margins sync .` in a folder with a GitHub remote must ask the server for a
 * CLIENT-sync workspace.
 *
 * The bug: the create call omitted `syncMode`, and the server defaults it to `"server"`
 * (margins/src/lib/services/workspaces.ts — `input.syncMode ?? "server"`). That produced a
 * server-clone workspace, while sync.ts went on to set `syncMode: 'client'` in
 * `.margins.json` and immediately CAS-push — which the server refuses with
 * 422 PUSH_SYNC_NOT_SUPPORTED (see the dedicated mapper in src/lib/cas-sync.ts).
 *
 * The failure was invisible to anyone WITHOUT a linked GitHub account: for them the create
 * throws GITHUB_NOT_LINKED, the catch-all falls back to a local workspace, and sync works.
 * Linking GitHub is what broke it. `margins install` never had the bug — it passes
 * `syncMode: 'client'` explicitly.
 *
 * These assert the REQUEST, not the response, because the request is the whole defect: the
 * server's default is correct for `workspace create`, and only this caller needs to opt out
 * of it.
 */

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPutRaw = vi.fn()

vi.mock('../../src/lib/api-client.js', () => ({
  createApiClient: () => ({ get: mockGet, post: mockPost, putRaw: mockPutRaw }),
}))

const { mockDetect } = vi.hoisted(() => ({ mockDetect: vi.fn() }))

vi.mock('../../src/lib/detect-git-remote.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/detect-git-remote.js')>(
    '../../src/lib/detect-git-remote.js',
  )
  return { ...actual, detectGitRemote: mockDetect }
})

const makeConfig = (): ResolvedConfig => ({
  serverUrl: 'https://margins.test',
  apiKey: 'mrgn_testkey123',
  json: true,
  verbose: false,
  noColor: false,
})

/** The POST that creates the workspace (not the manifest push that follows it). */
const createCall = () =>
  mockPost.mock.calls.find((c) => String(c[0]).includes('/api/workspaces') && !String(c[0]).includes('/sync/'))

let tmpDir: string
let dataDir: string
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockPutRaw.mockReset()
  mockDetect.mockReset()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-ghremote-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-data-'))
  vi.stubEnv('MARGINS_DATA_DIR', dataDir) // isolate repos.json writes
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello\n')
  mockGet.mockResolvedValue({ files: {}, headSha: null })
  mockPutRaw.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  logSpy.mockRestore()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('handleSync — GitHub remote must request a client-sync workspace', () => {
  it("sends syncMode: 'client' when creating the workspace for a GitHub-remote folder", async () => {
    mockDetect.mockReturnValue({ type: 'github', owner: 'alvistar', repo: 'ai-review' })
    mockPost.mockResolvedValue({ workspace: { id: 'ws-1', slug: 'gh/alvistar/ai-review' } })

    const { handleSync } = await import('../../src/commands/sync.js')
    await handleSync(makeConfig(), { dir: tmpDir })

    const call = createCall()
    expect(call, 'no workspace-create POST was issued').toBeDefined()
    const body = call![1] as Record<string, unknown>
    expect(body.source).toBe('github')
    expect(
      body.syncMode,
      "omitting syncMode lets the server default to 'server', and the CAS push that " +
        'follows then fails with 422 PUSH_SYNC_NOT_SUPPORTED',
    ).toBe('client')
  })

  it('agrees with the .margins.json it writes — requested mode and recorded mode match', async () => {
    mockDetect.mockReturnValue({ type: 'github', owner: 'alvistar', repo: 'ai-review' })
    mockPost.mockResolvedValue({ workspace: { id: 'ws-1', slug: 'gh/alvistar/ai-review' } })

    const { handleSync } = await import('../../src/commands/sync.js')
    await handleSync(makeConfig(), { dir: tmpDir })

    const requested = (createCall()![1] as Record<string, unknown>).syncMode
    const recorded = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.margins.json'), 'utf-8'),
    ) as { syncMode: string }
    // The original bug is exactly this disagreement: recorded 'client', requested (implicit) 'server'.
    expect(requested).toBe(recorded.syncMode)
  })

  it('still falls back to a local workspace when there is no GitHub remote', async () => {
    mockDetect.mockReturnValue({ type: 'none' })
    mockPost.mockResolvedValue({ workspace: { id: 'ws-2', slug: 'local/x' } })

    const { handleSync } = await import('../../src/commands/sync.js')
    await handleSync(makeConfig(), { dir: tmpDir })

    const body = createCall()![1] as Record<string, unknown>
    expect(body.source).toBe('local')
    expect(body.repoUrl, 'a local workspace has no repo URL').toBeUndefined()
  })
})
