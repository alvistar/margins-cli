import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../src/lib/config.js'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPutRaw = vi.fn()

vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({ get: mockGet, post: mockPost, putRaw: mockPutRaw }),
}))

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    serverUrl: 'https://margins.test',
    apiKey: 'test-token',
    json: true,
    verbose: false,
    noColor: false,
    ...overrides,
  } as ResolvedConfig
}

let tmpDir: string

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockPutRaw.mockReset()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-push-cfg-'))
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('handlePush — oversized blobs are skipped, not pushed', () => {
  it('excludes >2MB files from the upload and the manifest, reports them, and the push succeeds', async () => {
    const { MAX_BLOB_SIZE } = await import('../src/lib/collect-sync-files.js')
    fs.writeFileSync(
      path.join(tmpDir, '.margins.json'),
      JSON.stringify({ workspace_id: 'ws-1', workspace_slug: 'gh/x/y', syncMode: 'client' }),
    )
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello\n\n![huge](huge.png)\n')
    fs.writeFileSync(path.join(tmpDir, 'huge.png'), Buffer.alloc(MAX_BLOB_SIZE + 1, 1))

    mockGet.mockResolvedValue({ files: {}, headSha: null })
    mockPost.mockResolvedValue({ ok: true })
    mockPutRaw.mockResolvedValue({ ok: true })
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { handlePush } = await import('../src/commands/workspace/push.js')
    await handlePush(makeConfig(), { dir: tmpDir }) // resolves, no 413 abort

    // Only the markdown blob was uploaded; the oversized blob never left disk
    expect(mockPutRaw).toHaveBeenCalledTimes(1)
    // The committed manifest excludes the oversized path
    const manifest = (mockPost.mock.calls[0]![1] as { files: Record<string, string> }).files
    expect(Object.keys(manifest)).toEqual(['README.md'])
    // Reported as skipped: stderr list + counts in the JSON result
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('huge.png')
    const json = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as {
      skippedOversized: number; oversizedPaths: string[]
    }
    expect(json.skippedOversized).toBe(1)
    expect(json.oversizedPaths).toEqual(['huge.png'])

    stderrSpy.mockRestore()
    logSpy.mockRestore()
  })
})

describe('handlePush — workspace resolution from .margins.json', () => {
  it('uses workspace_id from .margins.json when no --workspace or --project flag', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.margins.json'),
      JSON.stringify({ workspace_id: 'ws-from-cfg', workspace_slug: 'gh/x/y' }),
    )
    // CAS sync: GET manifest, no PUTs (no changes), POST manifest
    mockGet.mockResolvedValueOnce({ files: {}, headSha: null })
    mockPost.mockResolvedValueOnce({ added: 1, changed: 0, deleted: 0, uploaded: 1, skipped: 0 })
    mockPutRaw.mockResolvedValue({ ok: true })

    const { handlePush } = await import('../src/commands/workspace/push.js')
    await handlePush(makeConfig(), { dir: tmpDir })

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/api/workspaces/ws-from-cfg/sync/manifest'),
      expect.anything(),
    )
  })

  it('--workspace flag takes precedence over .margins.json', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.margins.json'),
      JSON.stringify({ workspace_id: 'ws-from-cfg' }),
    )
    mockGet.mockResolvedValueOnce({ files: {}, headSha: null })
    mockPost.mockResolvedValueOnce({ added: 1, changed: 0, deleted: 0, uploaded: 1, skipped: 0 })
    mockPutRaw.mockResolvedValue({ ok: true })

    const { handlePush } = await import('../src/commands/workspace/push.js')
    await handlePush(makeConfig(), { workspace: 'ws-from-flag', dir: tmpDir })

    expect(mockGet).toHaveBeenCalledWith(
      expect.stringContaining('/api/workspaces/ws-from-flag/sync/manifest'),
      expect.anything(),
    )
  })

  it('still errors when no flag and no .margins.json present', async () => {
    const { handlePush } = await import('../src/commands/workspace/push.js')
    await expect(handlePush(makeConfig(), { dir: tmpDir })).rejects.toThrow(/Specify --workspace/)
  })

  it('ignores .margins.json without workspace_id (legacy file)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.margins.json'),
      JSON.stringify({ workspace_slug: 'gh/x/y' }),
    )
    const { handlePush } = await import('../src/commands/workspace/push.js')
    await expect(handlePush(makeConfig(), { dir: tmpDir })).rejects.toThrow(/Specify --workspace/)
  })
})
