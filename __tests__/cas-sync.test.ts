import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApiClient } from '../src/lib/api-client.js'
import type { ResolvedConfig } from '../src/lib/config.js'
import { casSync, syntheticCommitSha } from '../src/lib/cas-sync.js'
import { ConflictError, MergeConflictError } from '../src/lib/errors.js'

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
    await casSync(client, 'ws-1', 'main', syncFiles())

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
    await casSync(client, 'ws-1', 'main', syncFiles())

    const body = JSON.parse(calls.find((c) => c.method === 'POST')!.body!) as { parentSha: string | null }
    expect(body.parentSha).toBeNull()
  })

  it('on 409 refetches the manifest once and retries with the new headSha', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls = stubFetch((method, _url, counts) => {
      if (method === 'GET') {
        return apiOk({ files: {}, headSha: counts.get === 1 ? HEAD_1 : HEAD_2 })
      }
      if (method === 'PUT') return apiOk({ stored: true })
      // POST: first attempt conflicts, retry succeeds
      if (counts.post === 1) {
        return new Response(JSON.stringify({ error: { code: 'CONFLICT' } }), { status: 409 })
      }
      return apiOk({ ok: true })
    })

    const client = createApiClient(baseConfig())
    const result = await casSync(client, 'ws-1', 'main', syncFiles())
    expect(result.uploaded).toBe(2)

    // Exact call sequence: GET manifest, 2 blob PUTs, POST (409), GET refetch, POST retry
    const sequence = calls.map((c) => c.method)
    expect(sequence).toEqual(['GET', 'PUT', 'PUT', 'POST', 'GET', 'POST'])

    const posts = calls.filter((c) => c.method === 'POST')
    const retryBody = JSON.parse(posts[1]!.body!) as { parentSha: string | null; commitSha: string }
    expect(retryBody.parentSha).toBe(HEAD_2) // refetched headSha
    expect(retryBody.commitSha).toBe(vector.expectedSyntheticSha) // manifest unchanged

    // Loud log naming the replaced headSha and the differing file count
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(logged).toContain(HEAD_2)
    expect(logged).toMatch(/2 file/)
  })

  it('throws a typed ConflictError when the retry also returns 409', async () => {
    const calls = stubFetch((method, _url, counts) => {
      if (method === 'GET') {
        return apiOk({ files: {}, headSha: counts.get === 1 ? HEAD_1 : HEAD_2 })
      }
      if (method === 'PUT') return apiOk({ stored: true })
      return new Response(JSON.stringify({ error: { code: 'CONFLICT' } }), { status: 409 })
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const client = createApiClient(baseConfig())
    await expect(casSync(client, 'ws-1', 'main', syncFiles()))
      .rejects.toBeInstanceOf(ConflictError)

    // Exactly one retry: two POSTs total, no third attempt
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
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
    await casSync(client, 'ws-1', 'main', syncFiles()).catch((e) => { caught = e })

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
    await casSync(client, 'ws-1', 'main', syncFiles()).catch((e) => { caught = e })

    const msg = (caught as MergeConflictError).userMessage
    expect(msg).toContain('readme.md')
    expect(msg).toContain('docs/nested.md')
    expect(msg).toMatch(/did not land|reconcile|pull/i)
    // Conflict payload is preserved on the thrown error.
    expect((caught as MergeConflictError).conflicts).toHaveLength(2)
  })

  it('SIGINT during the 409-retry window → ConflictError naming the signal, no second POST', async () => {
    // The handler re-raises via process.kill — spy it out so the test runner
    // doesn't actually receive a SIGINT.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const calls = stubFetch((method, _url, counts) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      if (counts.post === 1) {
        // Deliver the signal between the 409 response and the retry path
        process.emit('SIGINT')
        return new Response(JSON.stringify({ error: { code: 'CONFLICT' } }), { status: 409 })
      }
      return apiOk({ ok: true })
    })

    const client = createApiClient(baseConfig())
    let caught: unknown
    await casSync(client, 'ws-1', 'main', syncFiles()).catch((err) => { caught = err })

    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as Error).message).toContain('SIGINT')
    // The retry POST was never sent — only the conflicting first attempt
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT')
  })

  it('signal handler removes itself and re-raises so default termination proceeds', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    let postCount = 0
    stubFetch((method) => {
      if (method === 'GET') return apiOk({ files: {}, headSha: HEAD_1 })
      if (method === 'PUT') return apiOk({ stored: true })
      if (++postCount === 1) {
        const before = process.listeners('SIGINT').length
        process.emit('SIGINT')
        // Handler removed itself before re-raising
        expect(process.listeners('SIGINT').length).toBe(before - 1)
        return new Response(JSON.stringify({ error: { code: 'CONFLICT' } }), { status: 409 })
      }
      return apiOk({ ok: true })
    })

    const client = createApiClient(baseConfig())
    await expect(casSync(client, 'ws-1', 'main', syncFiles()))
      .rejects.toBeInstanceOf(ConflictError)

    // Re-raised the same signal at itself for default disposition
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT')
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
    await expect(casSync(client, 'ws-1', 'main', syncFiles()))
      .rejects.toThrow(/does not support client push sync/)
  })
})
