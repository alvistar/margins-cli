import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { handlePush } from '../src/commands/workspace/push.js'
import { syntheticCommitSha } from '../src/lib/cas-sync.js'
import type { ResolvedConfig } from '../src/lib/config.js'

/**
 * `handlePush` coverage against the CAS protocol.
 *
 * History: this file's original 15 tests were written for the pre-CAS `/ingest`
 * endpoint and sat behind a skipped `describe` — the only disabled suite in the
 * repo — so `npm test` proved nothing about the push path. Retired rather than
 * ported: their assertions referenced a response shape from a deleted endpoint.
 *
 * Approach: mock ONLY the api-client. `casSync`, `collectSyncFiles`,
 * `skipOversized` and `resolveSyncMode` all run for real against real temp
 * directories, so these tests exercise the actual pipeline rather than a
 * re-statement of it. Following the precedent in
 * `__tests__/commands/sync-github-remote.test.ts`, assertions target the
 * REQUESTS ISSUED and their ORDER — the observable contract — not a response
 * shape we ourselves supplied.
 *
 * Adjacent files that own a slice of this surface and are deliberately not
 * duplicated here: `push-branch-flag.test.ts` (branch resolution),
 * `push-margins-json.test.ts` (oversized-blob skip), `cas-sync.test.ts` (the
 * protocol in isolation), `collect-sync-files.test.ts` (the collector).
 */

// ─── Api-client mock, recording call order ───────────────────────────────────

/** Ordered log of every request the push issues, in the order issued. */
let calls: string[] = []

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPutRaw = vi.fn()

vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({
    get: (p: string, q?: unknown) => {
      calls.push(`GET ${p}`)
      return mockGet(p, q)
    },
    post: (p: string, b?: unknown) => {
      calls.push(`POST ${p}`)
      return mockPost(p, b)
    },
    putRaw: (p: string, d: Buffer, ct: string) => {
      calls.push(`PUT ${p}`)
      return mockPutRaw(p, d, ct)
    },
  }),
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    serverUrl: 'https://margins.test',
    apiKey: 'mrgn_test',
    json: false,
    verbose: false,
    noColor: false,
    ...overrides,
  } as ResolvedConfig
}

const sha = (s: string): string => createHash('sha256').update(Buffer.from(s)).digest('hex')

/** The manifest POST body (the commit), as opposed to the workspace-create POST. */
function manifestPostBody(): {
  branch: string
  commitSha: string
  parentSha: string | null
  files: Record<string, string>
  confirmFullDelete?: boolean
} {
  const call = mockPost.mock.calls.find((c) => String(c[0]).includes('/sync/manifest'))
  if (!call) throw new Error(`no manifest POST issued; calls were: ${JSON.stringify(calls)}`)
  return call[1] as ReturnType<typeof manifestPostBody>
}

/** Reduce the ordered call log to its shape, so sequencing is assertable. */
function callShapes(): string[] {
  return calls.map((c) =>
    c.startsWith('PUT ') ? 'PUT blob'
      : c.includes('/sync/manifest') ? `${c.split(' ')[0]} manifest`
        : c,
  )
}

let tmpDir: string
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  calls = []
  mockGet.mockReset()
  mockPost.mockReset()
  mockPutRaw.mockReset()
  // Defaults: an empty server branch that accepts everything.
  mockGet.mockResolvedValue({ files: {}, headSha: null })
  mockPost.mockResolvedValue({})
  mockPutRaw.mockResolvedValue({})
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-push-'))
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const write = (rel: string, content: string | Buffer): void => {
  const full = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

// ─── Workspace resolution ────────────────────────────────────────────────────

describe('handlePush — workspace resolution', () => {
  it('--project creates a workspace and pushes to the id the server returned', async () => {
    write('README.md', '# Hi\n')
    mockPost.mockImplementation(async (p: string) => {
      if (p === '/api/workspaces') return { workspace: { id: 'ws-created', slug: 'local/u/docs' } }
      return {}
    })

    await handlePush(makeConfig(), { project: 'docs', dir: tmpDir, branch: 'main' })

    expect(mockPost.mock.calls[0]).toEqual([
      '/api/workspaces',
      { name: 'docs', source: 'local', projectName: 'docs' },
    ])
    // The created id — not the project name — addresses every sync route.
    expect(calls).toContain('GET /api/workspaces/ws-created/sync/manifest')
    expect(calls).toContain('POST /api/workspaces/ws-created/sync/manifest')
    expect(logSpy.mock.calls.map((c) => String(c[0]))).toContain('Created workspace: local/u/docs')
  })

  it('--workspace addresses that id directly, with no create call', async () => {
    write('README.md', '# Hi\n')

    await handlePush(makeConfig(), { workspace: 'ws-flag', dir: tmpDir, branch: 'main' })

    expect(calls).toContain('GET /api/workspaces/ws-flag/sync/manifest')
    expect(mockPost.mock.calls.some((c) => c[0] === '/api/workspaces')).toBe(false)
  })

  it('falls back to workspace_id in .margins.json when no flag is given', async () => {
    write('README.md', '# Hi\n')
    write('.margins.json', JSON.stringify({ workspace_id: 'ws-cfg', syncMode: 'client' }))

    await handlePush(makeConfig(), { dir: tmpDir, branch: 'main' })

    expect(calls).toContain('GET /api/workspaces/ws-cfg/sync/manifest')
  })

  it('--workspace wins over .margins.json', async () => {
    write('README.md', '# Hi\n')
    write('.margins.json', JSON.stringify({ workspace_id: 'ws-cfg', syncMode: 'client' }))

    await handlePush(makeConfig(), { workspace: 'ws-flag', dir: tmpDir, branch: 'main' })

    expect(calls.some((c) => c.includes('ws-cfg'))).toBe(false)
    expect(calls).toContain('GET /api/workspaces/ws-flag/sync/manifest')
  })

  it('refuses with no resolvable workspace, issuing no request at all', async () => {
    write('README.md', '# Hi\n')

    await expect(handlePush(makeConfig(), { dir: tmpDir })).rejects.toThrow(/Specify --workspace/)
    expect(calls).toEqual([])
  })

  it('a malformed .margins.json does not resolve a workspace (and does not crash)', async () => {
    write('README.md', '# Hi\n')
    write('.margins.json', '{ not json')

    await expect(handlePush(makeConfig(), { dir: tmpDir })).rejects.toThrow(/Specify --workspace/)
    expect(calls).toEqual([])
  })
})

// ─── Collection dispatch ─────────────────────────────────────────────────────

describe('handlePush — collection dispatch', () => {
  it('collects from --dir (not cwd) and sends exactly that tree', async () => {
    write('README.md', '# Hi\n')
    write('docs/spec.md', '# Spec\n')

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    expect(Object.keys(manifestPostBody().files).sort()).toEqual(['README.md', 'docs/spec.md'])
  })

  it('pulls in images referenced by the collected markdown', async () => {
    write('README.md', '# Hi\n\n![logo](img/logo.png)\n')
    write('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    expect(Object.keys(manifestPostBody().files).sort()).toEqual(['README.md', 'img/logo.png'])
    expect(mockPutRaw.mock.calls.map((c) => c[2]).sort()).toEqual(['image/png', 'text/markdown'])
  })

  it('an empty collection refuses locally, before any network call', async () => {
    // Current contract: `workspace push` throws on mdCount === 0 and never
    // reaches casSync — so the full-delete guard is unreachable from here.
    // (U4 changes this deliberately; this test is the tripwire.)
    await expect(
      handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' }),
    ).rejects.toThrow(`No .md files found in ${tmpDir}`)
    expect(calls).toEqual([])
  })
})

// ─── Upload and manifest sequencing ──────────────────────────────────────────

describe('handlePush — upload and manifest sequencing', () => {
  it('fetches the manifest, uploads blobs, then commits the manifest — in that order', async () => {
    write('README.md', '# Hi\n')
    write('docs/spec.md', '# Spec\n')

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    expect(callShapes()).toEqual([
      'GET manifest',
      'PUT blob',
      'PUT blob',
      'POST manifest',
    ])
  })

  it('uploads each blob to its content hash, and commits that same hash map', async () => {
    write('README.md', '# Hi\n')

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'feat/x' })

    const hash = sha('# Hi\n')
    expect(calls).toContain(`PUT /api/workspaces/ws-1/sync/objects/${hash}`)
    expect(mockPutRaw.mock.calls[0]![1].toString()).toBe('# Hi\n')
    const body = manifestPostBody()
    expect(body.files).toEqual({ 'README.md': hash })
    expect(body.branch).toBe('feat/x')
  })

  it('commits a synthetic commitSha over the manifest, with the server head as parent', async () => {
    write('README.md', '# Hi\n')
    mockGet.mockResolvedValue({ files: {}, headSha: 'server-head-sha' })

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    const body = manifestPostBody()
    expect(body.parentSha).toBe('server-head-sha')
    expect(body.commitSha).toBe(syntheticCommitSha(body.files))
    expect(body.commitSha).toMatch(/^[a-f0-9]{64}$/)
  })

  it('sends the branch as a query param on the manifest fetch', async () => {
    write('README.md', '# Hi\n')

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'feat/x' })

    expect(mockGet).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/sync/manifest',
      { branch: 'feat/x' },
    )
  })

  it('skips uploading a blob the server already holds, but still commits it', async () => {
    write('README.md', '# Hi\n')
    write('CHANGED.md', '# New\n')
    mockGet.mockResolvedValue({ files: { 'README.md': sha('# Hi\n') }, headSha: 'h' })

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    // Only the genuinely-new content was transferred.
    expect(mockPutRaw).toHaveBeenCalledTimes(1)
    expect(mockPutRaw.mock.calls[0]![0]).toBe(`/api/workspaces/ws-1/sync/objects/${sha('# New\n')}`)
    // ...yet the unchanged path stays in the committed manifest.
    expect(Object.keys(manifestPostBody().files).sort()).toEqual(['CHANGED.md', 'README.md'])
  })

  it('omits a server path that is gone locally, and reports it as deleted', async () => {
    write('README.md', '# Hi\n')
    mockGet.mockResolvedValue({
      files: { 'README.md': sha('# Hi\n'), 'GONE.md': sha('# Gone\n') },
      headSha: 'h',
    })

    await handlePush(makeConfig({ json: true }), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    expect(Object.keys(manifestPostBody().files)).toEqual(['README.md'])
    const out = JSON.parse(String(logSpy.mock.calls.at(-1)![0])) as { deleted: number }
    expect(out.deleted).toBe(1)
  })

  it('passes --confirm-full-delete through to the commit body', async () => {
    write('README.md', '# Hi\n')

    await handlePush(makeConfig(), {
      workspace: 'ws-1', dir: tmpDir, branch: 'main', confirmFullDelete: true,
    })

    expect(manifestPostBody().confirmFullDelete).toBe(true)
  })

  it('omits confirmFullDelete entirely when the flag is absent', async () => {
    write('README.md', '# Hi\n')

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    expect('confirmFullDelete' in manifestPostBody()).toBe(false)
  })
})

// ─── Failure paths ───────────────────────────────────────────────────────────

describe('handlePush — failure paths', () => {
  it('surfaces a 409 conflict without re-pushing', async () => {
    const { ConflictError } = await import('../src/lib/errors.js')
    write('README.md', '# Hi\n')
    mockPost.mockRejectedValue(new ConflictError('Conflict while calling /sync/manifest'))

    await expect(
      handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' }),
    ).rejects.toThrow(/conflicted with the server and was not applied/)

    // Exactly one commit attempt — a retry here would clobber a concurrent writer.
    expect(calls.filter((c) => c === 'POST /api/workspaces/ws-1/sync/manifest')).toHaveLength(1)
    expect(calls.filter((c) => c.startsWith('GET '))).toHaveLength(1)
  })

  it('names the conflicting file on a server-side merge conflict, and stops', async () => {
    const { MergeConflictError } = await import('../src/lib/errors.js')
    write('README.md', '# Hi\n')
    mockPost.mockRejectedValue(
      new MergeConflictError([{ path: 'README.md', reason: 'both-modified' }], 'head-sha'),
    )

    await expect(
      handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' }),
    ).rejects.toThrow(/README\.md conflicts with a newer change/)

    expect(calls.filter((c) => c.startsWith('POST '))).toHaveLength(1)
  })

  it('turns a 422 PUSH_SYNC_NOT_SUPPORTED on the manifest fetch into an actionable refusal, uploading nothing', async () => {
    const { ServerError } = await import('../src/lib/errors.js')
    write('README.md', '# Hi\n')
    mockGet.mockRejectedValue(new ServerError(422, 'PUSH_SYNC_NOT_SUPPORTED'))

    await expect(
      handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' }),
    ).rejects.toThrow(/does not support client push sync/)

    expect(mockPutRaw).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.startsWith('POST '))).toHaveLength(0)
  })

  it('propagates a blob-upload failure without committing a manifest', async () => {
    const { ServerError } = await import('../src/lib/errors.js')
    write('README.md', '# Hi\n')
    mockPutRaw.mockRejectedValue(new ServerError(413))

    await expect(
      handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' }),
    ).rejects.toThrow(/Server error 413/)

    expect(calls.filter((c) => c.startsWith('POST '))).toHaveLength(0)
  })

  it('propagates an auth failure from workspace creation before collecting anything', async () => {
    const { AuthExpired } = await import('../src/lib/errors.js')
    write('README.md', '# Hi\n')
    mockPost.mockRejectedValue(new AuthExpired())

    await expect(
      handlePush(makeConfig(), { project: 'docs', dir: tmpDir, branch: 'main' }),
    ).rejects.toThrow(/API key expired/)

    expect(calls).toEqual(['POST /api/workspaces'])
  })

  it('refuses a server-managed workspace with exit 1, before any upload', async () => {
    write('README.md', '# Hi\n')
    write('.margins.json', JSON.stringify({ workspace_id: 'ws-srv', syncMode: 'server' }))

    let uploadsAtExit = -1
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      uploadsAtExit = mockPutRaw.mock.calls.length
      return undefined as never
    }) as never)

    await handlePush(makeConfig(), { dir: tmpDir, branch: 'main' })

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(uploadsAtExit).toBe(0)
    expect(String(errSpy.mock.calls[0]![0])).toMatch(
      /server-managed sync\. Use `margins workspace sync` instead/,
    )
  })
})

// ─── Result reporting ────────────────────────────────────────────────────────

describe('handlePush — result reporting', () => {
  it('prints the CAS counts on a plain push', async () => {
    write('README.md', '# Hi\n')

    await handlePush(makeConfig(), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    expect(String(logSpy.mock.calls.at(-1)![0]))
      .toBe('Pushed: 1 added, 0 changed, 0 deleted (1 uploaded, 0 unchanged)')
  })

  it('emits the CAS result as JSON under --json', async () => {
    write('README.md', '# Hi\n')

    await handlePush(makeConfig({ json: true }), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    expect(JSON.parse(String(logSpy.mock.calls.at(-1)![0]))).toEqual({
      added: 1, changed: 0, deleted: 0, uploaded: 1, skipped: 0, merged: false,
    })
  })

  it('includes the created workspace metadata in the JSON result of a --project push', async () => {
    write('README.md', '# Hi\n')
    mockPost.mockImplementation(async (p: string) =>
      p === '/api/workspaces' ? { workspace: { id: 'ws-created', slug: 'local/u/docs' } } : {})

    await handlePush(makeConfig({ json: true }), { project: 'docs', dir: tmpDir, branch: 'main' })

    expect(JSON.parse(String(logSpy.mock.calls[0]![0])))
      .toEqual({ created: true, workspaceId: 'ws-created', slug: 'local/u/docs' })
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)![0])))
      .toMatchObject({ workspaceId: 'ws-created', slug: 'local/u/docs', added: 1 })
  })

  it('reports a clean server-side auto-merge with the server counts, not the local diff', async () => {
    write('README.md', '# Hi\n')
    mockPost.mockResolvedValue({ merged: true, added: 3, changed: 2, deleted: 1 })
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await handlePush(makeConfig({ json: true }), { workspace: 'ws-1', dir: tmpDir, branch: 'main' })

    expect(JSON.parse(String(logSpy.mock.calls.at(-1)![0])))
      .toMatchObject({ added: 3, changed: 2, deleted: 1, merged: true })
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join(''))
      .toMatch(/auto-merged with a concurrent edit/)
  })
})
