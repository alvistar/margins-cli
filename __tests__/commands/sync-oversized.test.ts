import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../../src/lib/config.js'
import { MAX_BLOB_SIZE } from '../../src/lib/collect-sync-files.js'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPutRaw = vi.fn()

vi.mock('../../src/lib/api-client.js', () => ({
  createApiClient: () => ({ get: mockGet, post: mockPost, putRaw: mockPutRaw }),
}))

const makeConfig = (): ResolvedConfig => ({
  serverUrl: 'https://margins.test',
  apiKey: 'mrgn_testkey123',
  json: true,
  verbose: false,
  noColor: false,
})

let tmpDir: string
let dataDir: string
let logSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockPutRaw.mockReset()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-oversized-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-data-'))
  vi.stubEnv('MARGINS_DATA_DIR', dataDir) // isolate repos.json writes
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.unstubAllEnvs()
  logSpy.mockRestore()
  stderrSpy.mockRestore()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('handleSync — oversized blobs are skipped, not pushed', () => {
  it('excludes >2MB files from the upload and the manifest, reports them, and the sync succeeds', async () => {
    // Pre-configured workspace: handleSync resumes straight to the CAS push
    fs.writeFileSync(
      path.join(tmpDir, '.margins.json'),
      JSON.stringify({
        workspace_id: 'ws-1',
        workspace_slug: 'gh/x/y',
        default_branch: 'main',
        syncMode: 'push',
      }),
    )
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello\n\n![huge](huge.png)\n')
    fs.writeFileSync(path.join(tmpDir, 'huge.png'), Buffer.alloc(MAX_BLOB_SIZE + 1, 1))

    mockGet.mockResolvedValue({ files: {}, headSha: null })
    mockPost.mockResolvedValue({ ok: true })
    mockPutRaw.mockResolvedValue({ ok: true })

    const { handleSync } = await import('../../src/commands/sync.js')
    await handleSync(makeConfig(), { dir: tmpDir }) // resolves, no 413 abort

    // Only the markdown blob was uploaded
    expect(mockPutRaw).toHaveBeenCalledTimes(1)
    // The committed manifest excludes the oversized path
    const manifestPost = mockPost.mock.calls.find(
      (c) => String(c[0]).includes('/sync/manifest'),
    )
    expect(manifestPost).toBeDefined()
    const manifest = (manifestPost![1] as { files: Record<string, string> }).files
    expect(Object.keys(manifest)).toEqual(['README.md'])
    // Reported as skipped: stderr list + counts in the JSON result
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('huge.png')
    const json = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as {
      status: string; skippedOversized: number; oversizedPaths: string[]
    }
    expect(json.status).toBe('synced')
    expect(json.skippedOversized).toBe(1)
    expect(json.oversizedPaths).toEqual(['huge.png'])
  })

  // Value: protects=top-level `margins sync` reports server-refused paths in --json (skippedRefused + refused) and drops them from the manifest; fails_when=handleSync ignores casResult.refused, so a skipped file is silently missing from the JSON a tray/agent reads; why_new=only the oversized skip was driven through handleSync; seam=none; no_claim=the human warn line
  it('reports a path the server refused in the JSON result, and syncs the rest', async () => {
    const { ServerError } = await import('../../src/lib/errors.js')
    fs.writeFileSync(
      path.join(tmpDir, '.margins.json'),
      JSON.stringify({ workspace_id: 'ws-1', workspace_slug: 'gh/x/y', default_branch: 'main', syncMode: 'push' }),
    )
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello\n')
    fs.writeFileSync(path.join(tmpDir, 'a b.md'), '# Spaced\n')

    mockGet.mockResolvedValue({ files: {}, headSha: null })
    mockPutRaw.mockResolvedValue({ ok: true })
    mockPost.mockRejectedValueOnce(
      new ServerError(400, 'VALIDATION_ERROR', 'Invalid file path: a b.md', undefined, ['a b.md']))
    mockPost.mockResolvedValue({ ok: true })

    const { handleSync } = await import('../../src/commands/sync.js')
    await handleSync(makeConfig(), { dir: tmpDir })

    const manifests = mockPost.mock.calls.filter((c) => String(c[0]).includes('/sync/manifest'))
    expect(Object.keys((manifests.at(-1)![1] as { files: Record<string, string> }).files)).toEqual(['README.md'])
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join(''))
      .toContain('Skipped a b.md — the server refused it: Invalid file path: a b.md')
    const json = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as {
      status: string; skippedRefused: number; refused: unknown[]
    }
    expect(json.status).toBe('synced')
    expect(json.skippedRefused).toBe(1)
    expect(json.refused).toEqual([{ path: 'a b.md', reason: 'Invalid file path: a b.md' }])
  })
})
