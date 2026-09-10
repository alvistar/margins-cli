/**
 * The transport's GET, added for the one caller that needs a precondition.
 *
 * `PUT /api/stash` takes an optional `parentSha`; without it the update is
 * unconditional and silently replaces whatever the stash has become. The Margins
 * Light daemon reads the current head from `GET /api/stash` so it can send one,
 * which is why this method exists at all.
 */
import { describe, it, expect, vi } from 'vitest'
import { createFetchStashHttp } from '../src/http.js'

describe('createFetchStashHttp — get', () => {
  it('sends no body, which a GET must not carry', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":[]}', { status: 200 }))
    const http = createFetchStashHttp({
      serverUrl: 'https://margins.test', apiKey: 'k', fetchImpl: fetchImpl as never,
    })
    await http.get('/api/stash')

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://margins.test/api/stash')
    expect(init.method).toBe('GET')
    expect(init).not.toHaveProperty('body')
  })

  it('parses the enveloped list and carries the bearer', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ slug: 's', head: 'sha1' }] }), { status: 200 }),
    )
    const http = createFetchStashHttp({
      serverUrl: 'https://margins.test', apiKey: 'mrgn_x', fetchImpl: fetchImpl as never,
    })
    const res = await http.get('/api/stash')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: [{ slug: 's', head: 'sha1' }] })
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer mrgn_x')
  })
})
