import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleStash } from '../src/commands/stash.js'
import type { ResolvedConfig } from '../src/lib/config.js'
import { ConflictError, ValidationError, ServerError, NotFoundError } from '../src/lib/errors.js'

const { mockPost, mockPut, mockGet, mockReadFileSync, bindings, mockConfirm } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockGet: vi.fn(),
  mockReadFileSync: vi.fn(),
  bindings: {
    lookupBinding: vi.fn(),
    recordBinding: vi.fn(),
    isAccepted: vi.fn(),
    recordAcceptance: vi.fn(),
  },
  mockConfirm: vi.fn(),
}))

vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({ post: mockPost, put: mockPut, get: mockGet }),
}))

vi.mock('margins-stash-core', async (importActual) => {
  const actual = await importActual<typeof import('margins-stash-core')>()
  return { ...actual, ...bindings }
})

vi.mock('@clack/prompts', () => ({
  confirm: mockConfirm,
  isCancel: (v: unknown) => v === Symbol.for('clack:cancel'),
}))

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>()
  return { ...actual, readFileSync: mockReadFileSync }
})

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiKey: 'mrgn_test',
    serverUrl: 'https://margins.test',
    json: false,
    verbose: false,
    ...overrides,
  } as ResolvedConfig
}

const OK = { workspace: { id: 'ws_1', slug: 'stash/alice/abcd1234', name: 'Untitled stash doc' } }
const DOC_URL = 'https://margins.test/w/stash/alice/abcd1234/-/main/document.md'

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

let logSpy: ReturnType<typeof vi.spyOn>

let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue(OK)
  mockPut.mockReset()
  // A server that advertises the design capability, unless a test says otherwise.
  mockGet.mockReset().mockResolvedValue({ version: '0.69.0', features: ['stash-html'] })
  mockReadFileSync.mockReset()
  bindings.lookupBinding.mockReset().mockReturnValue(null)
  bindings.recordBinding.mockReset()
  bindings.isAccepted.mockReset().mockReturnValue(true)
  bindings.recordAcceptance.mockReset()
  mockConfirm.mockReset()
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errSpy.mockRestore()
})

describe('handleStash', () => {
  it('publishes a file and prints the review URL built from the returned slug', async () => {
    mockReadFileSync.mockReturnValue('# Notes\n\nbody')
    await handleStash(makeConfig(), 'notes.md', {})
    expect(mockPost).toHaveBeenCalledWith('/api/stash', { content: '# Notes\n\nbody', title: 'Notes' })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(DOC_URL))
  })

  it('reads piped stdin when no file argument is given', async () => {
    setTTY(false)
    mockReadFileSync.mockReturnValue('piped body')
    await handleStash(makeConfig(), undefined, {})
    expect(mockReadFileSync).toHaveBeenCalledWith(0, 'utf8')
    expect(mockPost).toHaveBeenCalledWith('/api/stash', { content: 'piped body' })
  })

  it('lets --title win over a derived title', async () => {
    mockReadFileSync.mockReturnValue('# Heading\n\nbody')
    await handleStash(makeConfig(), 'notes.md', { title: 'Explicit' })
    expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ title: 'Explicit' }))
  })

  it('derives the title from the first level-1 heading when no --title', async () => {
    mockReadFileSync.mockReturnValue('intro line\n\n# Real Heading\n\nbody')
    await handleStash(makeConfig(), 'notes.md', {})
    expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ title: 'Real Heading' }))
  })

  it('falls back to the filename stem when there is no heading or --title', async () => {
    mockReadFileSync.mockReturnValue('just body, no heading')
    await handleStash(makeConfig(), '/tmp/q3-plan.md', {})
    expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ title: 'q3-plan' }))
  })

  it('emits machine-readable JSON with --json', async () => {
    mockReadFileSync.mockReturnValue('body')
    await handleStash(makeConfig({ json: true }), 'notes.md', {})
    const out = logSpy.mock.calls[0]?.[0] as string
    expect(JSON.parse(out)).toEqual({
      id: 'ws_1',
      slug: 'stash/alice/abcd1234',
      url: DOC_URL,
      action: 'created',
      format: 'markdown',
      path: 'document.md',
    })
  })

  it('rejects empty/whitespace content without calling the API', async () => {
    mockReadFileSync.mockReturnValue('   \n  ')
    await expect(handleStash(makeConfig(), 'empty.md', {})).rejects.toBeInstanceOf(ValidationError)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('reports a clean error when the file does not exist', async () => {
    mockReadFileSync.mockImplementation(() => {
      const e: NodeJS.ErrnoException = new Error('ENOENT')
      e.code = 'ENOENT'
      throw e
    })
    await expect(handleStash(makeConfig(), 'missing.md', {})).rejects.toThrow(/File not found/)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('maps a slug conflict (409) to a retry message', async () => {
    mockReadFileSync.mockReturnValue('body')
    mockPost.mockRejectedValue(new ConflictError('Conflict while calling /api/stash'))
    await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toThrow(/retry/i)
  })

  it('maps a 400 to a clear validation message', async () => {
    mockReadFileSync.mockReturnValue('body')
    mockPost.mockRejectedValue(new ServerError(400, 'MISSING_FIELDS'))
    await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses when no file argument is given and stdin is an interactive TTY', async () => {
    setTTY(true)
    await expect(handleStash(makeConfig(), undefined, {})).rejects.toThrow(/pipe markdown|file path/i)
    expect(mockPost).not.toHaveBeenCalled()
  })

  describe('--share', () => {
    const SHARE = { shareUrl: 'https://margins.test/s/Xk9z', slug: 'Xk9z', created: true }

    it('mints a share link in the same step and prints both URLs', async () => {
      mockReadFileSync.mockReturnValue('# Notes\n\nbody')
      mockPost.mockReset().mockResolvedValueOnce(OK).mockResolvedValueOnce(SHARE)

      await handleStash(makeConfig(), 'notes.md', { share: true })

      expect(mockPost).toHaveBeenNthCalledWith(1, '/api/stash', expect.objectContaining({ content: '# Notes\n\nbody' }))
      expect(mockPost).toHaveBeenNthCalledWith(2, '/api/stash/share', { slug: 'stash/alice/abcd1234' })
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(DOC_URL))
      expect(logSpy).toHaveBeenCalledWith(`Share link: ${SHARE.shareUrl}`)
    })

    it('includes shareUrl in --json output', async () => {
      mockReadFileSync.mockReturnValue('body')
      mockPost.mockReset().mockResolvedValueOnce(OK).mockResolvedValueOnce(SHARE)

      await handleStash(makeConfig({ json: true }), 'notes.md', { share: true })
      const out = logSpy.mock.calls[0]?.[0] as string
      expect(JSON.parse(out)).toEqual({
        id: 'ws_1',
        slug: 'stash/alice/abcd1234',
        url: DOC_URL,
        action: 'created',
        format: 'markdown',
        path: 'document.md',
        shareUrl: SHARE.shareUrl,
      })
    })

    it('does not call the share endpoint without --share', async () => {
      mockReadFileSync.mockReturnValue('body')
      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockPost).toHaveBeenCalledTimes(1)
      expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.anything())
    })

    it('reports an upgrade message when the server lacks the share endpoint (stash still created)', async () => {
      mockReadFileSync.mockReturnValue('body')
      mockPost
        .mockReset()
        .mockResolvedValueOnce(OK)
        .mockRejectedValueOnce(new NotFoundError('/api/stash/share')) // no code → route absent
      await expect(handleStash(makeConfig(), 'notes.md', { share: true })).rejects.toThrow(
        /does not support share links|update the server/i,
      )
    })
  })
})

// ─── Stash update path (U7): bound files update in place ─────────────────────

describe('handleStash — update flow (R11/R12/R13)', () => {
  const BINDING = { slug: 'stash/alice/abcd1234', workspaceId: 'ws_1' }
  const STORE = { kind: 'project', storePath: '/proj/.margins/stash-bindings.json', key: 'notes.md' }
  const UPDATED = {
    workspace: { id: 'ws_1', slug: BINDING.slug, name: 'Notes' },
    changed: true,
    url: 'https://margins.test/w/stash/alice/abcd1234',
    head: 'sha-new',
  }

  function bind() {
    bindings.lookupBinding.mockReturnValue({ store: STORE, binding: BINDING })
  }

  it('PUTs the update for a bound file and prints "Updated stash"', async () => {
    bind()
    mockReadFileSync.mockReturnValue('# Notes\n\nedited')
    mockPut.mockResolvedValue(UPDATED)

    await handleStash(makeConfig(), 'notes.md', {})

    expect(mockPut).toHaveBeenCalledWith('/api/stash', {
      slug: BINDING.slug,
      content: '# Notes\n\nedited',
      title: 'Notes',
      // Declared on every update (D5). The server refuses before it writes if
      // this stash turns out to hold a design, rather than storing markdown
      // over one.
      format: 'markdown',
    })
    expect(mockPost).not.toHaveBeenCalled() // no duplicate create
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Updated stash'))
  })

  it('prints "already up to date" when the server reports changed=false', async () => {
    bind()
    mockReadFileSync.mockReturnValue('# Notes\n\nsame')
    mockPut.mockResolvedValue({ ...UPDATED, changed: false })

    await handleStash(makeConfig(), 'notes.md', {})
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/already up to date/i))
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('emits action/changed/head in --json output for updates', async () => {
    bind()
    mockReadFileSync.mockReturnValue('body')
    mockPut.mockResolvedValue(UPDATED)

    await handleStash(makeConfig({ json: true }), 'notes.md', {})
    const out = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(out.action).toBe('updated')
    expect(out.changed).toBe(true)
    expect(out.head).toBe('sha-new')
  })

  it('--new skips the binding and creates a fresh stash (deliberate fork), rebinding', async () => {
    bind()
    mockReadFileSync.mockReturnValue('body')

    await handleStash(makeConfig(), 'notes.md', { new: true })
    expect(mockPut).not.toHaveBeenCalled()
    expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.anything())
    expect(bindings.recordBinding).toHaveBeenCalledWith('notes.md', {
      slug: 'stash/alice/abcd1234',
      workspaceId: 'ws_1',
      // Recorded from the response so the NEXT update can send it as parentSha.
      // Null here only because this mocked create returns no head.
      head: null,
    })
  })

  it('records a binding after a fresh create so the next run updates', async () => {
    mockReadFileSync.mockReturnValue('body')
    await handleStash(makeConfig(), 'notes.md', {})
    expect(bindings.recordBinding).toHaveBeenCalledWith('notes.md', {
      slug: 'stash/alice/abcd1234',
      workspaceId: 'ws_1',
      // Recorded from the response so the NEXT update can send it as parentSha.
      // Null here only because this mocked create returns no head.
      head: null,
    })
  })

  it('does not bind stdin input (no file identity)', async () => {
    setTTY(false)
    mockReadFileSync.mockReturnValue('piped body')
    await handleStash(makeConfig(), undefined, {})
    expect(bindings.lookupBinding).not.toHaveBeenCalled()
    expect(bindings.recordBinding).not.toHaveBeenCalled()
  })

  describe('recovery matrix (R11)', () => {
    it('enveloped 404 (stash swept) → recreates + rebinds, informing the user', async () => {
      bind()
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockRejectedValue(new NotFoundError('/api/stash', 'NOT_FOUND'))

      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.anything())
      expect(bindings.recordBinding).toHaveBeenCalled()
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/no longer exists/i))
    })

    it('403 NOT_A_MEMBER (foreign binding) → recreates + rebinds', async () => {
      bind()
      mockReadFileSync.mockReturnValue('body')
      const { ForbiddenError } = await import('../src/lib/errors.js')
      mockPut.mockRejectedValue(new ForbiddenError('/api/stash', 'NOT_A_MEMBER'))

      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.anything())
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/different account/i))
    })

    it('403 INSUFFICIENT_ROLE (invited reviewer) → hard error with --new hint, NO fork', async () => {
      bind()
      mockReadFileSync.mockReturnValue('body')
      const { ForbiddenError } = await import('../src/lib/errors.js')
      mockPut.mockRejectedValue(new ForbiddenError('/api/stash', 'INSUFFICIENT_ROLE'))

      await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toThrow(/comment-only|--new/i)
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('400 validation on update → actionable message, NO fork', async () => {
      bind()
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockRejectedValue(new ServerError(400))
      await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toThrow(/rejected|--verbose/i)
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('405 (old server, route exists without PUT) → upgrade error, NO fork', async () => {
      bind()
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockRejectedValue(new ServerError(405))

      await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toThrow(
        /does not support stash updates/i,
      )
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('bare code-less 404 (proxy fallback) → upgrade error, NO fork', async () => {
      bind()
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockRejectedValue(new NotFoundError('/api/stash')) // no code

      await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toThrow(
        /does not support stash updates/i,
      )
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('409 (e.g. REVERT_UNSUPPORTED) → surfaces the server message, NO fork', async () => {
      bind()
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockRejectedValue(
        new ConflictError('This content is byte-identical to an earlier version…', 'REVERT_UNSUPPORTED'),
      )

      await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toThrow(/byte-identical/i)
      expect(mockPost).not.toHaveBeenCalled()
    })
  })

  describe('trust gate (R13)', () => {
    it('prompts once for a binding not created on this machine; accept → PUT + acceptance recorded', async () => {
      bind()
      bindings.isAccepted.mockReturnValue(false)
      setTTY(true)
      mockConfirm.mockResolvedValue(true)
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockResolvedValue(UPDATED)

      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockConfirm).toHaveBeenCalled()
      expect(bindings.recordAcceptance).toHaveBeenCalledWith(STORE, BINDING)
      expect(mockPut).toHaveBeenCalled()
    })

    it('decline → creates a fresh stash instead (rebinds), never PUTs', async () => {
      bind()
      bindings.isAccepted.mockReturnValue(false)
      setTTY(true)
      mockConfirm.mockResolvedValue(false)
      mockReadFileSync.mockReturnValue('body')

      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockPut).not.toHaveBeenCalled()
      expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.anything())
      expect(bindings.recordBinding).toHaveBeenCalled()
    })

    it('--yes skips the prompt, records acceptance, and PUTs', async () => {
      bind()
      bindings.isAccepted.mockReturnValue(false)
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockResolvedValue(UPDATED)

      await handleStash(makeConfig(), 'notes.md', { yes: true })
      expect(mockConfirm).not.toHaveBeenCalled()
      expect(bindings.recordAcceptance).toHaveBeenCalledWith(STORE, BINDING)
      expect(mockPut).toHaveBeenCalled()
    })

    it('non-interactive without --yes → explicit error naming --yes and --new, no write', async () => {
      bind()
      bindings.isAccepted.mockReturnValue(false)
      setTTY(false)
      mockReadFileSync.mockReturnValue('body')

      await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toThrow(/--yes|--new/)
      expect(mockPut).not.toHaveBeenCalled()
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('non-accepted binding declined via clack CANCEL also falls back to a fresh create', async () => {
      bind()
      bindings.isAccepted.mockReturnValue(false)
      setTTY(true)
      mockConfirm.mockResolvedValue(Symbol.for('clack:cancel'))
      mockReadFileSync.mockReturnValue('body')

      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockPut).not.toHaveBeenCalled()
      expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.anything())
    })

    it('accepted bindings never prompt (solo dogfood flow stays frictionless)', async () => {
      bind()
      bindings.isAccepted.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockResolvedValue(UPDATED)

      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockConfirm).not.toHaveBeenCalled()
    })
  })

  describe('update title semantics', () => {
    it('does NOT send a filename-stem title on update (no custom-title clobber)', async () => {
      bind()
      mockReadFileSync.mockReturnValue('no heading here, just prose')
      mockPut.mockResolvedValue(UPDATED)

      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockPut).toHaveBeenCalledWith('/api/stash', {
        slug: BINDING.slug,
        content: 'no heading here, just prose',
        format: 'markdown',
      })
    })

    it('sends the H1-derived title on update (deliberate rename tracking)', async () => {
      bind()
      mockReadFileSync.mockReturnValue('# New Heading\n\nbody')
      mockPut.mockResolvedValue(UPDATED)
      await handleStash(makeConfig(), 'notes.md', {})
      expect(mockPut).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ title: 'New Heading' }))
    })
  })

  describe('create-failure leaves no binding', () => {
    it('does not record a binding when the create POST fails', async () => {
      mockReadFileSync.mockReturnValue('body')
      mockPost.mockRejectedValue(new ServerError(500))
      await expect(handleStash(makeConfig(), 'notes.md', {})).rejects.toBeInstanceOf(ServerError)
      expect(bindings.recordBinding).not.toHaveBeenCalled()
    })
  })

  describe('--share on the update path', () => {
    it('mints the (stable) share link after an update', async () => {
      bind()
      mockReadFileSync.mockReturnValue('body')
      mockPut.mockResolvedValue(UPDATED)
      mockPost.mockResolvedValue({ shareUrl: 'https://margins.test/s/Xk9z', slug: 'Xk9z', created: false })

      await handleStash(makeConfig(), 'notes.md', { share: true })
      expect(mockPost).toHaveBeenCalledWith('/api/stash/share', { slug: BINDING.slug })
      expect(logSpy).toHaveBeenCalledWith('Share link: https://margins.test/s/Xk9z')
    })
  })
})

// ─── HTML designs ─────────────────────────────────────────────────────────────
//
// `readFileSync` is mocked here, so the inliner sees no files on disk and leaves
// every reference alone with a warning. That is deliberate: the inliner has its
// own suite against a real temp directory (`html-inline.test.ts`). What these
// pin is everything AROUND it — which format is chosen, what reaches the wire,
// which URL is printed, and what the user is told when it goes wrong.

const HTML_CREATED = {
  workspace: { id: 'ws_h', slug: 'stash/alice/deadbeef', name: 'Pricing' },
  format: 'html',
  path: 'document.html',
  head: 'sha-1',
}
const DESIGN = '<!doctype html><html><head><title>Pricing</title></head><body><h1>Plans</h1></body></html>'

describe('handleStash — HTML designs', () => {
  it('infers html from the extension, sends format, and prints the document.html URL', async () => {
    mockReadFileSync.mockReturnValue(DESIGN)
    mockPost.mockReset().mockResolvedValue(HTML_CREATED)

    await handleStash(makeConfig(), 'site/index.html', {})

    expect(mockPost).toHaveBeenCalledWith('/api/stash', {
      content: DESIGN,
      title: 'Pricing',
      format: 'html',
    })
    // From the RESPONSE's path. The default is document.md, which does not exist
    // in a design's workspace, so a link built from it 404s on arrival.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://margins.test/w/stash/alice/deadbeef/-/main/document.html'),
    )
  })

  it('takes the title from <title>, never from a # in the CSS', async () => {
    mockReadFileSync.mockReturnValue('<style>\n#sidebar { color: red }\n</style><title>Brochure</title>')
    mockPost.mockReset().mockResolvedValue(HTML_CREATED)

    await handleStash(makeConfig(), 'page.html', {})

    expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ title: 'Brochure' }))
  })

  it('falls back to the first <h1> when there is no <title>', async () => {
    mockReadFileSync.mockReturnValue('<body><h1>Q3 <em>Plan</em></h1></body>')
    mockPost.mockReset().mockResolvedValue(HTML_CREATED)

    await handleStash(makeConfig(), 'page.html', {})

    // Tags stripped, whitespace collapsed.
    expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ title: 'Q3 Plan' }))
  })

  it('--format html publishes stdin as a design', async () => {
    setTTY(false)
    mockReadFileSync.mockReturnValue(DESIGN)
    mockPost.mockReset().mockResolvedValue(HTML_CREATED)

    await handleStash(makeConfig(), undefined, { format: 'html' })

    expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.objectContaining({ format: 'html' }))
  })

  it('stdin without --format is markdown, and sends NO format at all', async () => {
    setTTY(false)
    mockReadFileSync.mockReturnValue('# Piped\n')

    await handleStash(makeConfig(), undefined, {})

    expect(mockPost).toHaveBeenCalledWith('/api/stash', { content: '# Piped\n', title: 'Piped' })
  })

  it('--format markdown publishes a .html file as text', async () => {
    mockReadFileSync.mockReturnValue(DESIGN)

    await handleStash(makeConfig(), 'page.html', { format: 'markdown' })

    // Absent, not "markdown": the body must stay what every pre-HTML client sent.
    expect(mockPost).toHaveBeenCalledWith('/api/stash', expect.not.objectContaining({ format: expect.anything() }))
  })

  it('rejects a --format value that is neither', async () => {
    mockReadFileSync.mockReturnValue(DESIGN)
    await expect(handleStash(makeConfig(), 'page.html', { format: 'pdf' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    expect(mockPost).not.toHaveBeenCalled()
  })
})

describe('handleStash — designs against a server that cannot hold one', () => {
  it('refuses BEFORE creating anything when features omit stash-html', async () => {
    mockReadFileSync.mockReturnValue(DESIGN)
    mockGet.mockResolvedValue({ version: '0.68.0', features: ['something-else'] })

    const err = await handleStash(makeConfig(), 'page.html', {}).catch((e: Error) => e)

    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toMatch(/0\.68\.0/)
    expect((err as Error).message).toMatch(/Nothing was uploaded/)
    // The whole point of asking first: no stash exists to clean up.
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('proceeds on a LOW version that advertises the capability', async () => {
    // The regression this shape exists for, measured against a real dev server
    // on 2026-09-15. `/api/health`'s `version` is the web app's only in the
    // production image; started from `margins/` it falls back to
    // `npm_package_version` — the Margins Light RUNTIME version, an unrelated
    // series. A fully capable server reported 0.16.0 and a version comparison
    // refused to publish a design to it.
    mockReadFileSync.mockReturnValue(DESIGN)
    mockGet.mockResolvedValue({ version: '0.16.0', features: ['stash-html'] })
    mockPost.mockReset().mockResolvedValue(HTML_CREATED)

    await handleStash(makeConfig(), 'page.html', {})

    expect(mockPost).toHaveBeenCalled()
  })

  it('falls through when the server advertises no features at all', async () => {
    // Cannot be asked: too old, or behind a proxy that rewrote the body. Refusing
    // on uncertainty would block real work; the echo backstop catches the case
    // that is genuinely too old.
    mockReadFileSync.mockReturnValue(DESIGN)
    mockGet.mockResolvedValue({ version: '0.68.0' })
    mockPost.mockReset().mockResolvedValue(HTML_CREATED)

    await handleStash(makeConfig(), 'page.html', {})

    expect(mockPost).toHaveBeenCalled()
  })

  it('falls through when /api/health is unreachable', async () => {
    mockReadFileSync.mockReturnValue(DESIGN)
    mockGet.mockRejectedValue(new NotFoundError('no health route'))
    mockPost.mockReset().mockResolvedValue(HTML_CREATED)

    await handleStash(makeConfig(), 'page.html', {})

    expect(mockPost).toHaveBeenCalled()
  })

  it('names the stash it stranded when the server silently ignored format', async () => {
    // The backstop behind the preflight, and the case where the damage is
    // already done: the markdown stash EXISTS and this CLI has no delete.
    mockReadFileSync.mockReturnValue(DESIGN)
    mockGet.mockResolvedValue({ version: '0.68.0' }) // cannot be asked
    mockPost.mockReset().mockResolvedValue(OK) // no format/path echo

    const err = await handleStash(makeConfig(), 'page.html', {}).catch((e: Error) => e)

    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toContain('stash/alice/abcd1234')
    expect((err as Error).message).toMatch(/Delete it from the web UI/)
  })

  it('does not preflight for a markdown stash', async () => {
    mockReadFileSync.mockReturnValue('# Notes\n')
    await handleStash(makeConfig(), 'notes.md', {})
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('handleStash — updating with a head', () => {
  const HTML_BINDING = { slug: 'stash/alice/deadbeef', workspaceId: 'ws_h', head: 'sha-old' }
  const HTML_STORE = { kind: 'global' as const, storePath: '/tmp/b.json', key: 'page.html' }
  const HTML_UPDATED = {
    workspace: { id: 'ws_h', slug: HTML_BINDING.slug, name: 'Pricing' },
    changed: true,
    url: 'https://margins.test/w/stash/alice/deadbeef',
    head: 'sha-new',
    format: 'html',
    path: 'document.html',
  }

  function bindHtml(binding: Record<string, unknown> = HTML_BINDING) {
    bindings.lookupBinding.mockReturnValue({ store: HTML_STORE, binding })
  }

  it("sends the binding's head as parentSha and records the new one", async () => {
    bindHtml()
    mockReadFileSync.mockReturnValue(DESIGN)
    mockPut.mockResolvedValue(HTML_UPDATED)

    await handleStash(makeConfig(), 'page.html', {})

    expect(mockPut).toHaveBeenCalledWith('/api/stash', expect.objectContaining({
      parentSha: 'sha-old',
      format: 'html',
    }))
    expect(bindings.recordBinding).toHaveBeenCalledWith(
      'page.html',
      expect.objectContaining({ head: 'sha-new' }),
    )
  })

  it('--force omits parentSha entirely', async () => {
    bindHtml()
    mockReadFileSync.mockReturnValue(DESIGN)
    mockPut.mockResolvedValue(HTML_UPDATED)

    await handleStash(makeConfig(), 'page.html', { force: true })

    const body = mockPut.mock.calls[0]![1] as Record<string, unknown>
    expect(body).not.toHaveProperty('parentSha')
  })

  it('a binding with no head overwrites once, says so, and records the head (D9)', async () => {
    bindHtml({ slug: HTML_BINDING.slug, workspaceId: 'ws_h' })
    mockReadFileSync.mockReturnValue(DESIGN)
    mockPut.mockResolvedValue(HTML_UPDATED)

    await handleStash(makeConfig(), 'page.html', {})

    const body = mockPut.mock.calls[0]![1] as Record<string, unknown>
    expect(body).not.toHaveProperty('parentSha')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('overwrote it without checking'))
    // And it is protected from here on.
    expect(bindings.recordBinding).toHaveBeenCalledWith(
      'page.html',
      expect.objectContaining({ head: 'sha-new' }),
    )
  })

  it('says nothing about overwriting when the binding DID carry a head', async () => {
    // The positive control. A notice on every update would train the user to
    // ignore the one that matters.
    bindHtml()
    mockReadFileSync.mockReturnValue(DESIGN)
    mockPut.mockResolvedValue(HTML_UPDATED)

    await handleStash(makeConfig(), 'page.html', {})

    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('overwrote it without checking'))
  })
})

describe('handleStash — what the server says reaches the user', () => {
  const B = { slug: 'stash/alice/deadbeef', workspaceId: 'ws_h', head: 'sha-old' }
  const STORE_H = { kind: 'global' as const, storePath: '/tmp/b.json', key: 'page.html' }

  it('prints an HTML refusal verbatim instead of the generic validation sentence', async () => {
    mockReadFileSync.mockReturnValue(DESIGN)
    mockPost.mockReset().mockRejectedValue(
      new ServerError(400, 'HTML_TOO_COMPLEX', 'This document has 30000 elements; the limit is 20000.'),
    )

    const err = await handleStash(makeConfig(), 'page.html', {}).catch((e: Error) => e)

    // `toContain`, not `toBe`: ValidationError prefixes "Validation error: ".
    // What matters is that the server's own sentence survives whole.
    expect((err as Error).message).toContain('This document has 30000 elements; the limit is 20000.')
    expect((err as Error).message).not.toMatch(/Use --verbose/)
  })

  it('points a format mismatch at --new, never at --force', async () => {
    bindings.lookupBinding.mockReturnValue({ store: STORE_H, binding: B })
    mockReadFileSync.mockReturnValue('# markdown\n')
    mockPut.mockRejectedValue(
      new ConflictError('This stash holds html, not markdown.', 'FORMAT_MISMATCH'),
    )

    const err = await handleStash(makeConfig(), 'notes.md', {}).catch((e: Error) => e)

    expect((err as Error).message).toContain('This stash holds html, not markdown.')
    expect((err as Error).message).toContain('--new')
    // A stash's format is fixed at creation; forcing cannot convert it.
    expect((err as Error).message).not.toContain('--force')
  })

  it('offers --force and --new on a genuine conflict', async () => {
    bindings.lookupBinding.mockReturnValue({ store: STORE_H, binding: B })
    mockReadFileSync.mockReturnValue(DESIGN)
    mockPut.mockRejectedValue(new ConflictError('This Design changed since parentSha.'))

    const err = await handleStash(makeConfig(), 'page.html', {}).catch((e: Error) => e)

    expect((err as Error).message).toContain('This Design changed since parentSha.')
    expect((err as Error).message).toContain('--force')
    expect((err as Error).message).toContain('--new')
  })
})
