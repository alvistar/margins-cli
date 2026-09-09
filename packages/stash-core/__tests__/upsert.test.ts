/**
 * The stash recovery matrix, at the seam the CLI's own tests cannot see.
 *
 * `__tests__/stash.test.ts` in the CLI still covers every branch through
 * `handleStash`, because that is where the branches used to live and moving them
 * must not lose that coverage. What is here is the part the CLI has no way to
 * exercise: the behaviours this package offers to its OTHER caller, the Margins
 * Light daemon — `parentSha`, the absence of a trust prompt, and the reason a
 * rebind happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { upsertStash, type BindingsPort, type StashHttp, type StashResponse } from '../src/index.js'

const BINDING = { slug: 'stash/alice/abcd1234', workspaceId: 'ws_1' }
const STORE = { kind: 'project' as const, storePath: '/proj/.margins/stash-bindings.json', key: 'notes.md' }

const CREATED: StashResponse = {
  status: 200,
  body: { workspace: { id: 'ws_2', slug: 'stash/alice/newnew12', name: 'Notes' } },
}
const UPDATED: StashResponse = {
  status: 200,
  body: {
    workspace: { id: 'ws_1', slug: BINDING.slug, name: 'Notes' },
    changed: true,
    url: 'https://margins.test/w/x',
    head: 'sha-new',
  },
}

function makeBindings(bound: boolean, accepted = true): BindingsPort {
  return {
    lookupBinding: vi.fn(() => (bound ? { store: STORE, binding: BINDING } : null)),
    recordBinding: vi.fn(() => STORE),
    isAccepted: vi.fn(() => accepted),
    recordAcceptance: vi.fn(),
  } as unknown as BindingsPort
}

function makeHttp(put: StashResponse | Error, post: StashResponse = CREATED): StashHttp & {
  post: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
} {
  return {
    get: vi.fn(async () => ({ status: 200, body: {} })),
    post: vi.fn(async () => post),
    put: vi.fn(async () => {
      if (put instanceof Error) throw put
      return put
    }),
  } as never
}

describe('upsertStash — options the daemon needs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends parentSha on the update so a stash that moved answers 409 instead of being overwritten', async () => {
    const http = makeHttp(UPDATED)
    await upsertStash({
      http, content: 'body', filePath: 'notes.md', parentSha: 'sha-old',
      bindings: makeBindings(true),
    })
    expect(http.put).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ parentSha: 'sha-old' }))
  })

  it('omits parentSha entirely when none was given — an unconditional update', async () => {
    // Not `parentSha: undefined`: the server reads the KEY's presence, so sending
    // it as undefined and sending nothing are the same on the wire only by luck
    // of JSON.stringify. Asserted so a refactor to an always-present key is caught.
    const http = makeHttp(UPDATED)
    await upsertStash({ http, content: 'body', filePath: 'notes.md', bindings: makeBindings(true) })
    expect(http.put.mock.calls[0]?.[1]).not.toHaveProperty('parentSha')
  })

  it('surfaces a 409 with the head it disagreed with, and does NOT retry or create', async () => {
    const http = makeHttp({
      status: 409,
      code: 'SYNC_MERGE_CONFLICT',
      message: 'The document changed since parentSha.',
      body: { head: 'sha-theirs' },
    })
    const result = await upsertStash({
      http, content: 'body', filePath: 'notes.md', parentSha: 'sha-mine',
      bindings: makeBindings(true),
    })

    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'CONFLICT',
        status: 409,
        head: 'sha-theirs',
        serverMessage: 'The document changed since parentSha.',
      },
    })
    expect(http.put).toHaveBeenCalledTimes(1) // no second attempt
    expect(http.post).not.toHaveBeenCalled() // and no fork
  })

  it('refuses an untrusted binding when no confirmTrust is supplied, and creates a fresh stash', async () => {
    // The daemon's posture: nobody to ask, so never overwrite a stranger's stash.
    const bindings = makeBindings(true, false)
    const http = makeHttp(UPDATED)
    const result = await upsertStash({ http, content: 'body', filePath: 'notes.md', bindings })

    expect(http.put).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, action: 'created', rebound: true, reboundReason: 'trust-declined' })
    expect(bindings.recordAcceptance).not.toHaveBeenCalled()
  })

  it('reports WHY it rebound — a swept stash and a foreign one are different news', async () => {
    const missing = await upsertStash({
      http: makeHttp({ status: 404, code: 'NOT_FOUND' }),
      content: 'body', filePath: 'notes.md', bindings: makeBindings(true),
    })
    expect(missing).toMatchObject({ rebound: true, reboundReason: 'missing' })

    const foreign = await upsertStash({
      http: makeHttp({ status: 403, code: 'NOT_A_MEMBER' }),
      content: 'body', filePath: 'notes.md', bindings: makeBindings(true),
    })
    expect(foreign).toMatchObject({ rebound: true, reboundReason: 'foreign' })
  })

  it('leaves rebound false and reboundReason absent on an ordinary first create', async () => {
    const result = await upsertStash({
      http: makeHttp(UPDATED), content: 'body', filePath: 'notes.md',
      bindings: makeBindings(false),
    })
    expect(result).toMatchObject({ ok: true, action: 'created', rebound: false })
    expect(result).not.toHaveProperty('reboundReason')
  })

  it('turns a transport throw into NETWORK rather than letting it escape', async () => {
    const result = await upsertStash({
      http: makeHttp(new Error('ECONNREFUSED')),
      content: 'body', filePath: 'notes.md', bindings: makeBindings(true),
    })
    expect(result).toEqual({ ok: false, failure: { code: 'NETWORK' } })
  })

  it('keeps the old-server test ahead of the generic 404, so a bare 404 never forks', async () => {
    const http = makeHttp({ status: 404 }) // no code
    const result = await upsertStash({
      http, content: 'body', filePath: 'notes.md', bindings: makeBindings(true),
    })
    expect(result).toMatchObject({ ok: false, failure: { code: 'OLD_SERVER' } })
    expect(http.post).not.toHaveBeenCalled()
  })

  it('never binds content with no file identity', async () => {
    const bindings = makeBindings(true)
    await upsertStash({ http: makeHttp(UPDATED), content: 'piped', bindings })
    expect(bindings.lookupBinding).not.toHaveBeenCalled()
    expect(bindings.recordBinding).not.toHaveBeenCalled()
  })

  it('sends updateTitle on the update and title on the create — they are not the same field', async () => {
    const http = makeHttp(UPDATED)
    await upsertStash({
      http, content: 'body', filePath: 'notes.md',
      title: 'stem-fallback', updateTitle: undefined,
      bindings: makeBindings(true),
    })
    // A stem-derived title must not reach an update: it would overwrite a title
    // the owner set, every time a heading-less document was re-published.
    expect(http.put.mock.calls[0]?.[1]).not.toHaveProperty('title')

    const http2 = makeHttp(UPDATED)
    await upsertStash({
      http: http2, content: 'body', filePath: 'notes.md',
      title: 'stem-fallback', updateTitle: 'From The Heading',
      bindings: makeBindings(true),
    })
    expect(http2.put).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ title: 'From The Heading' }))
  })
})
