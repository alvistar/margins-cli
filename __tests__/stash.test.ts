import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleStash } from '../src/commands/stash.js'
import type { ResolvedConfig } from '../src/lib/config.js'
import { ConflictError, ValidationError, ServerError } from '../src/lib/errors.js'

const { mockPost, mockReadFileSync } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockReadFileSync: vi.fn(),
}))

vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({ post: mockPost }),
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

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue(OK)
  mockReadFileSync.mockReset()
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
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
    expect(JSON.parse(out)).toEqual({ id: 'ws_1', slug: 'stash/alice/abcd1234', url: DOC_URL })
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
})
