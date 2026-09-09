/**
 * The fetch transport's ONE job that the matrix depends on: telling a response
 * that carried an error code from one that carried nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { createFetchStashHttp } from '../src/http.js'

function res(status: number, body?: string): Response {
  return new Response(body ?? null, { status, headers: { 'content-type': 'application/json' } })
}

describe('createFetchStashHttp', () => {
  it('leaves `code` undefined for a body-less 404 — the old-server signal', async () => {
    // If this invented a code, `upsertStash` would read the 404 as "stash gone"
    // and fork a second stash against a server that simply has no PUT route.
    const http = createFetchStashHttp({
      serverUrl: 'https://margins.test', apiKey: 'k', fetchImpl: vi.fn(async () => res(404)) as never,
    })
    expect(await http.put('/api/stash', {})).toEqual({ status: 404, code: undefined, message: undefined, body: undefined })
  })

  it('reads the flat `{ error, message }` envelope', async () => {
    const http = createFetchStashHttp({
      serverUrl: 'https://margins.test', apiKey: 'k',
      fetchImpl: vi.fn(async () => res(403, JSON.stringify({ error: 'NOT_A_MEMBER', message: 'no' }))) as never,
    })
    expect(await http.put('/api/stash', {})).toMatchObject({ status: 403, code: 'NOT_A_MEMBER', message: 'no' })
  })

  it('reads the nested `{ error: { code } }` envelope too', async () => {
    const http = createFetchStashHttp({
      serverUrl: 'https://margins.test', apiKey: 'k',
      fetchImpl: vi.fn(async () => res(409, JSON.stringify({ error: { code: 'REVERT_UNSUPPORTED', message: 'identical' } }))) as never,
    })
    expect(await http.put('/api/stash', {})).toMatchObject({ status: 409, code: 'REVERT_UNSUPPORTED', message: 'identical' })
  })

  it('does not throw on a non-JSON body', async () => {
    const http = createFetchStashHttp({
      serverUrl: 'https://margins.test', apiKey: 'k',
      fetchImpl: vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as never,
    })
    expect(await http.put('/api/stash', {})).toMatchObject({ status: 502, code: undefined })
  })

  it('sends the bearer token and trims a trailing slash from the server URL', async () => {
    const fetchImpl = vi.fn(async () => res(200, '{}'))
    const http = createFetchStashHttp({
      serverUrl: 'https://margins.test/', apiKey: 'mrgn_x', fetchImpl: fetchImpl as never,
    })
    await http.post('/api/stash', { content: 'c' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://margins.test/api/stash')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer mrgn_x')
  })
})
