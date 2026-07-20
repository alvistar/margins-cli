import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createApiClient } from '../src/lib/api-client.js'
import type { ResolvedConfig } from '../src/lib/config.js'
import { casSync, fetchSyncPreflight, syntheticCommitSha } from '../src/lib/cas-sync.js'
import type { ApiClient } from '../src/lib/api-client.js'
import type { CasSyncOptions } from '../src/lib/cas-sync.js'
import { ConflictError, MergeConflictError, FullDeleteNotConfirmedError } from '../src/lib/errors.js'

// Shared test vector — must stay byte-identical to the desktop implementation
// (margins-desktop src-tauri/src/sync/cas_sync.rs synthetic_commit_sha).
const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/synthetic-sha-vector.json'), 'utf-8'),
) as { manifest: Record<string, string>; expectedSyntheticSha: string }

const baseConfig = (): ResolvedConfig => ({
  apiKey: 'mrgn_testkey123',
  serverUrl: 'https://margins.example.com',
  json: false,
  verbose: false,
  noColor: false,
})

// File contents 'x' and 'y' hash to the vector's manifest hashes.
// Deliberately NOT in sorted-path order — the synthetic SHA must sort.
const syncFiles = () => [
  { path: 'readme.md', content: Buffer.from('y'), contentType: 'text/markdown' },
  { path: 'docs/nested.md', content: Buffer.from('x'), contentType: 'text/markdown' },
]

const HEAD_1 = 'ab'.repeat(32)
const HEAD_2 = 'cd'.repeat(32)

// Server wraps every response in { data: ... } via apiOk()
const apiOk = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status })

interface RecordedCall {
  method: string
  url: string
  body?: string
}

/** Stub global fetch with a router; returns the recorded call list. */
function stubFetch(
  route: (method: string, url: string, callNo: { get: number; post: number }) => Response,
): RecordedCall[] {
  const calls: RecordedCall[] = []
  const counts = { get: 0, post: 0 }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      url: String(url),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    if (method === 'GET') counts.get++
    if (method === 'POST') counts.post++
    return route(method, String(url), counts)
  }))
  return calls
}

/**
 * The preflight is the CALLER's since U4 — `casSync` no longer fetches it. This
 * helper reproduces what `workspace push` / `sync` do: fetch, then push under
 * the mode the preflight settled. The GET still goes through the same stubbed
 * fetch, so per-method call counts below are unchanged.
 */
async function preflightAndSync(
  client: ApiClient,
  workspaceId: string,
  branch: string,
  files: Parameters<typeof casSync>[3],
  opts: Partial<CasSyncOptions> = {},
) {
  const preflight = await fetchSyncPreflight(client, workspaceId, branch)
  return casSync(client, workspaceId, branch, files, {
    preflight,
    contentMode: 'working-tree',
    ...opts,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─── syntheticCommitSha ──────────────────────────────────────────────────────

describe('syntheticCommitSha', () => {
  it('produces a 64-char lowercase hex SHA matching the shared test vector', () => {
    const sha = syntheticCommitSha(vector.manifest)
    expect(sha).toMatch(/^[a-f0-9]{64}$/)
    expect(sha).toBe(vector.expectedSyntheticSha)
  })

  it('is deterministic: same manifest twice gives the same sha', () => {
    expect(syntheticCommitSha(vector.manifest)).toBe(syntheticCommitSha(vector.manifest))
  })

  it('is insertion-order independent (sorts by path)', () => {
    const reversed: Record<string, string> = {}
    for (const key of Object.keys(vector.manifest).reverse()) {
      reversed[key] = vector.manifest[key]!
    }
    expect(syntheticCommitSha(reversed)).toBe(vector.expectedSyntheticSha)
  })

  it('changes when a single file hash changes', () => {
    const mutated = { ...vector.manifest, 'readme.md': 'f'.repeat(64) }
    expect(syntheticCommitSha(mutated)).not.toBe(vector.expectedSyntheticSha)
    expect(syntheticCommitSha(mutated)).toMatch(/^[a-f0-9]{64}$/)
  })
})

// ─── casSync wire protocol ───────────────────────────────────────────────────

describe('casSync', () => {
  it('sends parentSha = server headSha from GET and commitSha = synthetic sha of posted files', async () => {
    const calls = stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      return apiOk({ ok: true })
    })

    const client = createApiClient(baseConfig())
    await preflightAndSync(client, 'ws-1', 'main', syncFiles())

    const post = calls.find((c) => c.method === 'POST')
    expect(post).toBeDefined()
    const body = JSON.parse(post!.body!) as {
      branch: string
      commitSha: string
      parentSha: string | null
      files: Record<string, string>
    }
    expect(body.branch).toBe('main')
    expect(body.parentSha).toBe(HEAD_1) // server headSha, NOT git state
    expect(body.commitSha).toBe(vector.expectedSyntheticSha)
    expect(body.commitSha).toMatch(/^[a-f0-9]{64}$/)
    expect(body.files).toEqual(vector.manifest)
  })

  it('sends parentSha = null on initial sync (server has no headSha)', async () => {
    const calls = stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: null })
      if (method === 'PUT') return apiOk({ stored: true })
      return apiOk({ ok: true })
    })

    const client = createApiClient(baseConfig())
    await preflightAndSync(client, 'ws-1', 'main', syncFiles())

    const body = JSON.parse(calls.find((c) => c.method === 'POST')!.body!) as { parentSha: string | null }
    expect(body.parentSha).toBeNull()
  })

  it('on an unrecognized (non-merge) 409: surfaces-and-stops, NEVER refetches or re-pushes', async () => {
    // Post-PR2 the server only emits SYNC_MERGE_CONFLICT for a 409, but an
    // unrecognized 409 must still surface-and-stop — never overwrite. Exactly
    // one POST, no refetch GET.
    const calls = stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      return new Response(JSON.stringify({ error: 'SOME_OTHER_409' }), { status: 409 })
    })

    const client = createApiClient(baseConfig())
    let caught: unknown
    await preflightAndSync(client, 'ws-1', 'main', syncFiles()).catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(ConflictError)
    expect(caught).not.toBeInstanceOf(MergeConflictError)
    // No clobber: exactly one POST, exactly one GET (no refetch-and-repush).
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  // ─── SYNC_MERGE_CONFLICT: surface-and-stop, never clobber (U2) ──────────────

  const mergeConflict = (head: string, conflicts = [{ path: 'readme.md', reason: 'content' }]) =>
    new Response(JSON.stringify({
      error: 'SYNC_MERGE_CONFLICT',
      message: 'Divergent push could not be merged cleanly; resolve the conflicts and re-push.',
      merged: false,
      conflicts,
      head,
    }), { status: 409 })

  it('on SYNC_MERGE_CONFLICT: exactly one POST, no refetch, no clobber re-push (AE1, AE3)', async () => {
    const calls = stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      return mergeConflict(HEAD_1) // POST → merge conflict
    })

    const client = createApiClient(baseConfig())
    let caught: unknown
    await preflightAndSync(client, 'ws-1', 'main', syncFiles()).catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(MergeConflictError)
    expect((caught as MergeConflictError).exitCode).toBe(1) // non-zero exit
    // The clobbering refetch-and-repost never runs: one POST, one GET.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })

  it('names the conflicting file(s) and a reconcile next step', async () => {
    stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      return mergeConflict(HEAD_1, [
        { path: 'readme.md', reason: 'content' },
        { path: 'docs/nested.md', reason: 'delete-modify' },
      ])
    })

    const client = createApiClient(baseConfig())
    let caught: unknown
    await preflightAndSync(client, 'ws-1', 'main', syncFiles()).catch((e) => { caught = e })

    const msg = (caught as MergeConflictError).userMessage
    expect(msg).toContain('readme.md')
    expect(msg).toContain('docs/nested.md')
    expect(msg).toMatch(/did not land|reconcile|pull/i)
    // Conflict payload is preserved on the thrown error.
    expect((caught as MergeConflictError).conflicts).toHaveLength(2)
  })

  // ─── Clean auto-merge: notify + advise, no file writes (U3) ─────────────────

  it('on 200 merged: prints the auto-merge notice and reports the server counts (AE2)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      // Server auto-merged: counts describe the MERGED tree, not the local 2-file diff.
      return apiOk({
        added: 5, changed: 2, deleted: 1, merged: true,
        head: HEAD_2, files: { 'readme.md': 'a'.repeat(64) },
      })
    })

    const client = createApiClient(baseConfig())
    // casSync never touches the filesystem (push-only) — nothing to write.
    const result = await preflightAndSync(client, 'ws-1', 'main', syncFiles())

    expect(result.merged).toBe(true)
    expect(result).toMatchObject({ added: 5, changed: 2, deleted: 1 }) // server counts, not local
    expect(result.uploaded).toBe(2) // blob-transfer stats stay local

    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(logged).toMatch(/auto-merged/i)
    expect(logged).toMatch(/behind|pull|re-sync/i)
  })

  it('on a plain 200 fast-forward (no merged): local counts, merged=false, no notice (R7)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      return apiOk({ added: 99, changed: 99, deleted: 99 }) // no `merged` → server counts ignored
    })

    const client = createApiClient(baseConfig())
    const result = await preflightAndSync(client, 'ws-1', 'main', syncFiles())

    expect(result.merged).toBe(false)
    // Local diff: server empty, 2 local files → 2 added.
    expect(result).toMatchObject({ added: 2, changed: 0, deleted: 0 })

    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(logged).not.toMatch(/auto-merged/i)
  })

  it('maps 422 PUSH_SYNC_NOT_SUPPORTED to an actionable error message', async () => {
    stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: null })
      if (method === 'PUT') return apiOk({ stored: true })
      return new Response(
        JSON.stringify({ error: { code: 'PUSH_SYNC_NOT_SUPPORTED', message: 'nope' } }),
        { status: 422 },
      )
    })

    const client = createApiClient(baseConfig())
    await expect(preflightAndSync(client, 'ws-1', 'main', syncFiles()))
      .rejects.toThrow(/does not support client push sync/)
  })

  // ─── Full-branch-delete guard (U5) ─────────────────────────────────────────

  it('refuses a push that empties a populated branch without the flag (sends nothing destructive)', async () => {
    const calls = stubFetch((method) => {
      // Server has a file; the local push carries none → would empty the branch.
      if (method === 'GET') return apiOk({ files: { 'readme.md': 'ab'.repeat(32) }, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      return apiOk({ added: 0, changed: 0, deleted: 1 })
    })

    const client = createApiClient(baseConfig())
    let caught: unknown
    await preflightAndSync(client, 'ws-1', 'main', []).catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(FullDeleteNotConfirmedError)
    expect((caught as FullDeleteNotConfirmedError).userMessage).toMatch(/--confirm-full-delete/)
    // Nothing destructive left the client: no POST manifest, no PUT blob.
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('with the flag, posts files:{} and confirmFullDelete:true and succeeds', async () => {
    const calls = stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: { 'readme.md': 'ab'.repeat(32) }, headSha: HEAD_1 })
      return apiOk({ added: 0, changed: 0, deleted: 1 })
    })

    const client = createApiClient(baseConfig())
    const result = await preflightAndSync(client, 'ws-1', 'main', [], { confirmFullDelete: true })

    const post = calls.find((c) => c.method === 'POST')
    expect(post).toBeDefined()
    const body = JSON.parse(post!.body!) as {
      files: Record<string, string>
      confirmFullDelete?: boolean
    }
    expect(body.files).toEqual({})
    expect(body.confirmFullDelete).toBe(true)
    expect(result.deleted).toBe(1)
  })

  it('does not require the flag for a partial delete (some files remain)', async () => {
    const calls = stubFetch((method) => {
      // Server has two files; local keeps readme.md and drops extra.md.
      if (method === 'GET') {
        return apiOk({
          files: { 'readme.md': sha256y(), 'extra.md': 'cd'.repeat(32) },
          headSha: HEAD_1,
        })
      }
      return apiOk({ added: 0, changed: 0, deleted: 1 })
    })

    const client = createApiClient(baseConfig())
    const result = await preflightAndSync(
      client,
      'ws-1',
      'main',
      [{ path: 'readme.md', content: Buffer.from('y'), contentType: 'text/markdown' }],
    )

    const post = calls.find((c) => c.method === 'POST')
    expect(post).toBeDefined()
    const body = JSON.parse(post!.body!) as { files: Record<string, string>; confirmFullDelete?: boolean }
    expect(Object.keys(body.files)).toEqual(['readme.md'])
    expect(body.confirmFullDelete).toBeUndefined() // flag omitted when not requested
    expect(result.deleted).toBe(1)
  })

  it("maps a server 409 SYNC_FULL_DELETE_NOT_CONFIRMED to an actionable error", async () => {
    // Contrived: local is non-empty (proactive guard passes) but the server
    // still rejects — exercises the api-client 409 → error mapping.
    stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: { 'old.md': 'cd'.repeat(32) }, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      return new Response(
        JSON.stringify({ error: 'SYNC_FULL_DELETE_NOT_CONFIRMED', message: 'This push would delete all files.' }),
        { status: 409 },
      )
    })

    const client = createApiClient(baseConfig())
    let caught: unknown
    await preflightAndSync(client, 'ws-1', 'main', [
      { path: 'readme.md', content: Buffer.from('y'), contentType: 'text/markdown' },
    ]).catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(FullDeleteNotConfirmedError)
  })
})

// ─── Git provenance on the manifest POST (wire contract §6) ──────────────────

describe('casSync — git provenance', () => {
  const postBody = (calls: RecordedCall[]): Record<string, unknown> =>
    JSON.parse(calls.find((c) => c.method === 'POST' && c.url.endsWith('/manifest'))!.body!)

  it('sends gitCommitSha + gitObjectFormat when the collection carried provenance', async () => {
    const calls = stubFetch((method) =>
      method === 'GET'
        ? apiOk({ files: {}, headSha: null, contentMode: 'committed' })
        : apiOk({ added: 2, changed: 0, deleted: 0 }))

    const gitCommitSha = 'a'.repeat(40)
    await preflightAndSync(createApiClient(baseConfig()), 'ws-1', 'main', syncFiles(), {
      contentMode: 'committed',
      gitProvenance: { gitCommitSha, gitObjectFormat: 'sha1' },
    })

    const body = postBody(calls)
    expect(body.gitCommitSha).toBe(gitCommitSha)
    expect(body.gitObjectFormat).toBe('sha1')
    // Provenance rides BESIDE the content shas; it never becomes one of them.
    expect(body.commitSha).toBe(syntheticCommitSha({
      'readme.md': createHash('sha256').update(Buffer.from('y')).digest('hex'),
      'docs/nested.md': createHash('sha256').update(Buffer.from('x')).digest('hex'),
    }))
    expect(body.commitSha).not.toBe(gitCommitSha)
    expect(body.parentSha).toBeNull()
  })

  it('carries a 64-hex sha with format sha256, rather than assuming SHA-1 (KTD9)', async () => {
    const calls = stubFetch((method) =>
      method === 'GET'
        ? apiOk({ files: {}, headSha: null, contentMode: 'committed' })
        : apiOk({ added: 2, changed: 0, deleted: 0 }))

    await preflightAndSync(createApiClient(baseConfig()), 'ws-1', 'main', syncFiles(), {
      contentMode: 'committed',
      gitProvenance: { gitCommitSha: 'b'.repeat(64), gitObjectFormat: 'sha256' },
    })

    const body = postBody(calls)
    expect(body.gitObjectFormat).toBe('sha256')
    expect(String(body.gitCommitSha)).toHaveLength(64)
  })

  it('omits BOTH fields for a working-tree push (the both-or-neither rule)', async () => {
    const calls = stubFetch((method) =>
      method === 'GET'
        ? apiOk({ files: {}, headSha: null, contentMode: 'working-tree' })
        : apiOk({ added: 2, changed: 0, deleted: 0 }))

    await preflightAndSync(createApiClient(baseConfig()), 'ws-1', 'main', syncFiles())

    const body = postBody(calls)
    expect(body).not.toHaveProperty('gitCommitSha')
    expect(body).not.toHaveProperty('gitObjectFormat')
  })
})

/** sha256 of 'y' — the hash the server reports for readme.md in partial-delete. */
function sha256y(): string {
  return createHash('sha256').update(Buffer.from('y')).digest('hex')
}
