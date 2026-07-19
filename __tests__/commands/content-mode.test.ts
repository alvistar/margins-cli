import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ResolvedConfig } from '../../src/lib/config.js'
import { ConflictError, ForbiddenError, ServerError } from '../../src/lib/errors.js'

/**
 * `margins workspace content-mode` — the migration and its branch-scoped
 * preview (U8, R13/R14, KTD5/KTD15/KTD16).
 *
 * The preview is a LOCAL diff: the preflight the client already makes carries
 * the branch's path→hash map, and collecting locally in the TARGET mode names
 * every path the switch would stop sending. Nothing about it may write — that
 * is the property these tests are built around, so the mocked client records
 * every write and the confirm prompt snapshots the write count at the exact
 * instant the preview finished.
 */

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPut = vi.fn()
const mockPatch = vi.fn()
const mockDelete = vi.fn()
const mockPutRaw = vi.fn()

/** Every write the command issued, in order, whatever the verb. */
const writes: Array<{ verb: string; path: string; body?: unknown }> = []

function recordingWrite(verb: string, fn: ReturnType<typeof vi.fn>) {
  return async (p: string, body?: unknown, ...rest: unknown[]) => {
    writes.push({ verb, path: p, body })
    return fn(p, body, ...rest)
  }
}

vi.mock('../../src/lib/api-client.js', () => ({
  createApiClient: () => ({
    get: mockGet,
    post: recordingWrite('POST', mockPost),
    put: recordingWrite('PUT', mockPut),
    patch: recordingWrite('PATCH', mockPatch),
    delete: recordingWrite('DELETE', mockDelete),
    putRaw: recordingWrite('PUT-RAW', mockPutRaw),
  }),
}))

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }))

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  confirm: mockConfirm,
}))

const makeConfig = (json = false): ResolvedConfig => ({
  serverUrl: 'https://margins.test',
  apiKey: 'mrgn_testkey123',
  json,
  verbose: false,
  noColor: false,
} as ResolvedConfig)

let tmpDir: string
let dataDir: string
let originalIsTTY: unknown
let out: string[]

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

function git(args: string[]): void {
  execFileSync('git', args, { cwd: tmpDir, stdio: 'ignore' })
}

/** Everything the command printed, on either stream, as one blob. */
function printed(): string {
  return out.join('\n')
}

beforeEach(() => {
  for (const m of [mockGet, mockPost, mockPut, mockPatch, mockDelete, mockPutRaw, mockConfirm]) {
    m.mockReset()
  }
  mockPut.mockResolvedValue({ contentMode: 'committed', previousMode: 'working-tree' })
  mockPost.mockResolvedValue({})
  writes.length = 0
  out = []

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-content-mode-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-content-mode-data-'))
  vi.stubEnv('MARGINS_DATA_DIR', dataDir)
  vi.stubEnv('MARGINS_CONFIG_DIR', dataDir)
  originalIsTTY = process.stdin.isTTY
  setTTY(true)

  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@margins.test'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'core.autocrlf', 'false'])

  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')) })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out.push(String(s)); return true })
})

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** A committed `kept.md` plus an UNTRACKED `private.md` on disk. */
function repoWithUntrackedFile(): void {
  fs.writeFileSync(path.join(tmpDir, 'kept.md'), '# Kept\n')
  git(['add', 'kept.md'])
  git(['commit', '-qm', 'first'])
  fs.writeFileSync(path.join(tmpDir, 'private.md'), '# Private\n')
}

/**
 * Route the reads. The manifest GET is the preflight; the branches GET is what
 * names the branches the preview did NOT inspect.
 */
function routeReads(opts: {
  contentMode?: 'working-tree' | 'committed'
  files?: Record<string, string>
  branches?: string[]
} = {}): void {
  mockGet.mockImplementation(async (p: string) => {
    if (p.includes('/sync/manifest')) {
      return {
        files: opts.files ?? {},
        headSha: 'head-1',
        ...(opts.contentMode === undefined ? {} : { contentMode: opts.contentMode }),
      }
    }
    if (p.endsWith('/branches')) {
      return { branches: opts.branches ?? ['main'], defaultBranch: 'main' }
    }
    return {}
  })
}

const run = async (
  mode: string | undefined,
  opts: Record<string, unknown> = {},
  json = false,
): Promise<void> => {
  const { handleContentMode } = await import('../../src/commands/workspace/content-mode.js')
  await handleContentMode(makeConfig(json), { mode, dir: tmpDir, workspace: 'ws-1', ...opts })
}

// ─── The preview ─────────────────────────────────────────────────────────────

describe('margins workspace content-mode — the preview (R14, KTD16)', () => {
  it('names an untracked file the switch would stop sending, before applying', async () => {
    repoWithUntrackedFile()
    routeReads({
      contentMode: 'working-tree',
      files: { 'kept.md': 'h1', 'private.md': 'h2' },
    })

    // Snapshot the write log at the exact moment the preview finished: the
    // confirm prompt is the first thing that runs after it.
    let printedAtConfirm = ''
    mockConfirm.mockImplementation(async () => { printedAtConfirm = printed(); return true })

    await run('committed')

    expect(printedAtConfirm).toMatch(/private\.md/)
    expect(printedAtConfirm).not.toMatch(/kept\.md/)
    // …and the mutation went out afterwards, against the mode it was replacing.
    const setMode = writes.filter((w) => w.path.endsWith('/content-mode'))
    expect(setMode).toHaveLength(1)
    expect(setMode[0]!.verb).toBe('PUT')
    expect(setMode[0]!.path).toBe('/api/workspaces/ws-1/content-mode')
    expect(setMode[0]!.body).toEqual({
      mode: 'committed', expectedMode: 'working-tree', hasGitRepo: true,
    })
  })

  it('names the branch it inspected and lists the others as uninspected', async () => {
    repoWithUntrackedFile()
    routeReads({
      contentMode: 'working-tree',
      files: { 'kept.md': 'h1', 'private.md': 'h2' },
      branches: ['main', 'feature/x', 'release/1.0'],
    })
    mockConfirm.mockResolvedValue(false)

    await run('committed')

    const text = printed()
    expect(text).toMatch(/main/)
    expect(text).toMatch(/not inspected|uninspected/i)
    expect(text).toMatch(/feature\/x/)
    expect(text).toMatch(/release\/1\.0/)
    // It must not claim the preview covered the whole workspace.
    expect(text).toMatch(/workspace-wide|every branch|whole workspace/i)
  })

  it('previews an empty removal list rather than erroring when both modes agree', async () => {
    fs.writeFileSync(path.join(tmpDir, 'kept.md'), '# Kept\n')
    git(['add', 'kept.md'])
    git(['commit', '-qm', 'first'])
    routeReads({ contentMode: 'working-tree', files: { 'kept.md': 'h1' } })
    mockConfirm.mockResolvedValue(true)

    await expect(run('committed')).resolves.toBeUndefined()

    expect(printed()).toMatch(/no file|nothing/i)
    expect(writes.filter((w) => w.path.endsWith('/content-mode'))).toHaveLength(1)
  })

  it('issues no write of any kind across the whole preview path', async () => {
    repoWithUntrackedFile()
    routeReads({
      contentMode: 'working-tree',
      files: { 'kept.md': 'h1', 'private.md': 'h2' },
      branches: ['main', 'feature/x'],
    })

    let writesAtConfirm = -1
    mockConfirm.mockImplementation(async () => { writesAtConfirm = writes.length; return false })

    await run('committed')

    // The mechanism: the count is snapshotted INSIDE the prompt, so it covers
    // every request the preview made — preflight, branch listing, collection.
    expect(writesAtConfirm).toBe(0)
    expect(writes).toEqual([])
    // …and the reads it did make are exactly the two it is allowed.
    const readPaths = mockGet.mock.calls.map((c) => String(c[0]))
    expect(readPaths.filter((p) => p.includes('/sync/manifest'))).toHaveLength(1)
    expect(readPaths.every((p) => p.includes('/sync/manifest') || p.endsWith('/branches'))).toBe(true)
  })
})

// ─── Declining and refusing ──────────────────────────────────────────────────

describe('margins workspace content-mode — refusals (R13)', () => {
  it('declining leaves the mode untouched, with no network write', async () => {
    repoWithUntrackedFile()
    routeReads({ contentMode: 'working-tree', files: { 'private.md': 'h2' } })
    mockConfirm.mockResolvedValue(false)

    await run('committed')

    expect(writes).toEqual([])
    expect(printed()).toMatch(/unchanged|nothing was changed|not changed/i)
    // The untracked file is still on disk — nothing local was touched either.
    expect(fs.existsSync(path.join(tmpDir, 'private.md'))).toBe(true)
  })

  it('refuses a non-interactive run that did not pass the acceptance flag', async () => {
    repoWithUntrackedFile()
    routeReads({ contentMode: 'working-tree', files: { 'private.md': 'h2' } })
    setTTY(false)

    await expect(run('committed')).rejects.toThrow(/not interactive/i)

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    // The cost is still shown — a refusal the user cannot see the reason for is
    // worse than the prompt it replaces.
    expect(printed()).toMatch(/private\.md/)
  })

  it('applies without prompting when the acceptance flag is passed', async () => {
    repoWithUntrackedFile()
    routeReads({ contentMode: 'working-tree', files: { 'private.md': 'h2' } })
    setTTY(false)

    await run('committed', { yes: true })

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(writes.filter((w) => w.path.endsWith('/content-mode'))).toHaveLength(1)
  })

  it('refuses a mode someone else changed between the preview and the apply', async () => {
    repoWithUntrackedFile()
    routeReads({ contentMode: 'working-tree', files: { 'private.md': 'h2' } })
    mockConfirm.mockResolvedValue(true)
    mockPut.mockRejectedValue(new ConflictError(
      'Content mode changed since you read it: it is no longer "working-tree". ' +
      'Re-read the mode and decide again — nothing was changed.',
      'CONTENT_MODE_CONFLICT',
    ))

    await expect(run('committed')).rejects.toThrow(/no longer "working-tree"/)
  })

  it('surfaces the server\'s action-managed refusal rather than replacing it', async () => {
    repoWithUntrackedFile()
    routeReads({ contentMode: 'working-tree', files: { 'private.md': 'h2' } })
    mockConfirm.mockResolvedValue(true)
    const serverMessage =
      'This workspace is managed by repo acme/docs: its GitHub Actions workflow pushes the ' +
      'content… ask the workspace creator to set the override ({"action":"override-on"}).'
    mockPut.mockRejectedValue(
      new ForbiddenError('/api/workspaces/ws-1/content-mode', 'WORKSPACE_ACTION_MANAGED', serverMessage),
    )

    await expect(run('committed')).rejects.toThrow(/acme\/docs/)
    await expect(run('committed')).rejects.toThrow(/override-on/)
  })

  it('surfaces the server\'s not-applicable refusal', async () => {
    repoWithUntrackedFile()
    routeReads({ contentMode: 'working-tree', files: { 'private.md': 'h2' } })
    mockConfirm.mockResolvedValue(true)
    mockPut.mockRejectedValue(new ServerError(
      422,
      'CONTENT_MODE_NOT_APPLICABLE',
      'This workspace uses server-managed sync: Margins clones the repository itself.',
    ))

    await expect(run('committed')).rejects.toThrow(/server-managed sync/)
  })

  it('is idempotent: re-stating the mode already stored writes nothing', async () => {
    repoWithUntrackedFile()
    routeReads({ contentMode: 'working-tree', files: {} })

    await run('working-tree')

    expect(writes).toEqual([])
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(printed()).toMatch(/already/i)
  })

  it('refuses committed mode outside a git repository, before any network write', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-nogit-'))
    try {
      routeReads({ contentMode: 'working-tree', files: {} })
      await expect(run('committed', { dir: bare })).rejects.toThrow(/git repository/i)
      expect(writes).toEqual([])
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })

  it('refuses a server that reports no content mode at all', async () => {
    repoWithUntrackedFile()
    routeReads({ files: {} })   // no contentMode field — the server predates this

    await expect(run('committed')).rejects.toThrow(/does not support/i)
    expect(writes).toEqual([])
  })

  it('emits exactly one JSON object per run, preview and result together', async () => {
    repoWithUntrackedFile()
    routeReads({ contentMode: 'working-tree', files: { 'private.md': 'h2' } })
    setTTY(false)

    await run('committed', { yes: true }, true)

    // stdout carried one object, not a preview object followed by a result
    // object — two concatenated objects are not JSON a script can parse.
    const stdout = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(stdout).toHaveLength(1)
    const payload = JSON.parse(String(stdout[0]![0]))
    expect(payload.wouldStopSending).toEqual(['private.md'])
    expect(payload.changed).toBe(true)
    expect(payload.contentMode).toBe('committed')
  })

  it('refuses an unknown mode locally, before any request', async () => {
    await expect(run('committed-ish')).rejects.toThrow(/working-tree.*committed|committed.*working-tree/)
    expect(mockGet).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
})
