import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleStash } from '../src/commands/stash.js'
import type { ResolvedConfig } from '../src/lib/config.js'
import { ConflictError, ValidationError, ServerError, NotFoundError } from '../src/lib/errors.js'

const { mockPost, mockPut, mockReadFileSync, bindings, mockConfirm } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockPut: vi.fn(),
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
  createApiClient: () => ({ post: mockPost, put: mockPut }),
}))

vi.mock('../src/lib/stash-bindings.js', () => bindings)

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
    expect(JSON.parse(out)).toEqual({ id: 'ws_1', slug: 'stash/alice/abcd1234', url: DOC_URL, action: 'created' })
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
      expect(JSON.parse(out)).toEqual({ id: 'ws_1', slug: 'stash/alice/abcd1234', url: DOC_URL, action: 'created', shareUrl: SHARE.shareUrl })
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
    })
  })

  it('records a binding after a fresh create so the next run updates', async () => {
    mockReadFileSync.mockReturnValue('body')
    await handleStash(makeConfig(), 'notes.md', {})
    expect(bindings.recordBinding).toHaveBeenCalledWith('notes.md', {
      slug: 'stash/alice/abcd1234',
      workspaceId: 'ws_1',
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
      expect(mockPut).toHaveBeenCalledWith('/api/stash', { slug: BINDING.slug, content: 'no heading here, just prose' })
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
