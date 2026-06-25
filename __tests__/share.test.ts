import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleShare, parseStashSlug } from '../src/commands/share.js'
import type { ResolvedConfig } from '../src/lib/config.js'
import { NotFoundError, ValidationError } from '../src/lib/errors.js'

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }))

vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({ post: mockPost }),
}))

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiKey: 'mrgn_test',
    serverUrl: 'https://margins.test',
    json: false,
    verbose: false,
    ...overrides,
  } as ResolvedConfig
}

const SLUG = 'stash/alice/abcd1234'
const SHARE_OK = { shareUrl: 'https://margins.test/s/Xk9z', slug: 'Xk9z', created: true }

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue(SHARE_OK)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => logSpy.mockRestore())

describe('parseStashSlug', () => {
  it('returns a bare slug unchanged', () => {
    expect(parseStashSlug('stash/alice/abcd1234')).toBe('stash/alice/abcd1234')
  })
  it('extracts the slug from a full reader URL', () => {
    expect(parseStashSlug('https://margins.test/w/stash/alice/abcd1234/-/main/document.md')).toBe(SLUG)
  })
  it('extracts the slug from a /w/ URL without a branch segment', () => {
    expect(parseStashSlug('https://margins.test/w/stash/alice/abcd1234')).toBe(SLUG)
  })
  it('strips a trailing slash and query/hash', () => {
    expect(parseStashSlug('/w/stash/alice/abcd1234/?x=1#y')).toBe(SLUG)
    expect(parseStashSlug('stash/alice/abcd1234#frag')).toBe(SLUG)
  })
})

describe('handleShare', () => {
  it('prints the /s/<slug> URL returned by the server', async () => {
    await handleShare(makeConfig(), SLUG)
    expect(mockPost).toHaveBeenCalledWith('/api/stash/share', { slug: SLUG })
    expect(logSpy).toHaveBeenCalledWith(`Share link: ${SHARE_OK.shareUrl}`)
  })

  it('parses a full /w/ URL argument before calling the API', async () => {
    await handleShare(makeConfig(), 'https://margins.test/w/stash/alice/abcd1234/-/main/document.md')
    expect(mockPost).toHaveBeenCalledWith('/api/stash/share', { slug: SLUG })
  })

  it('returns the same URL on re-run (server get-or-create is idempotent)', async () => {
    mockPost.mockResolvedValue({ ...SHARE_OK, created: false })
    await handleShare(makeConfig(), SLUG)
    await handleShare(makeConfig(), SLUG)
    expect(logSpy).toHaveBeenNthCalledWith(1, `Share link: ${SHARE_OK.shareUrl}`)
    expect(logSpy).toHaveBeenNthCalledWith(2, `Share link: ${SHARE_OK.shareUrl}`)
  })

  it('emits machine-readable JSON with --json', async () => {
    await handleShare(makeConfig({ json: true }), SLUG)
    const out = logSpy.mock.calls[0]?.[0] as string
    expect(JSON.parse(out)).toEqual({ slug: 'Xk9z', shareUrl: SHARE_OK.shareUrl, created: true })
  })

  it('feature-detects an out-of-date server (404 with no code) with an upgrade message', async () => {
    mockPost.mockRejectedValue(new NotFoundError('/api/stash/share')) // no code → route absent
    await expect(handleShare(makeConfig(), SLUG)).rejects.toBeInstanceOf(ValidationError)
    await expect(handleShare(makeConfig(), SLUG)).rejects.toThrow(/does not support share links|update the server/i)
  })

  it('reports a clear "stash not found" when the 404 carries a server code', async () => {
    mockPost.mockRejectedValue(new NotFoundError('/api/stash/share', 'SHARE_FORBIDDEN'))
    await expect(handleShare(makeConfig(), SLUG)).rejects.toThrow(/Stash not found/i)
  })

  it('rejects an empty argument without calling the API', async () => {
    await expect(handleShare(makeConfig(), '   ')).rejects.toBeInstanceOf(ValidationError)
    expect(mockPost).not.toHaveBeenCalled()
  })
})
