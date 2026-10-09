/**
 * `margins sync-mode push [workspace]` — the standalone switch to push
 * (ai-review#282, user story 6), and the error mapping it shares with install.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ResolvedConfig } from '../../src/lib/config.js'

const { mockConfirm, mockDetect, mockLocal } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockDetect: vi.fn(),
  mockLocal: vi.fn(),
}))
vi.mock('@clack/prompts', () => ({
  confirm: mockConfirm,
  isCancel: (v: unknown) => v === Symbol.for('clack:cancel'),
}))
vi.mock('../../src/lib/detect-git-remote.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/detect-git-remote.js')>(
    '../../src/lib/detect-git-remote.js',
  )
  return { ...actual, detectGitRemote: mockDetect }
})
vi.mock('../../src/lib/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/config.js')>('../../src/lib/config.js')
  return { ...actual, readLocalConfig: mockLocal }
})

import { handleSyncMode } from '../../src/commands/sync-mode.js'
import { mapSwitchError } from '../../src/lib/sync-mode-switch.js'
import {
  ConflictError, ForbiddenError, NotFoundError, ServerError,
} from '../../src/lib/errors.js'

const cfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  apiKey: 'mrgn_testkey123',
  serverUrl: 'https://margins.test',
  json: false,
  verbose: false,
  noColor: false,
  ...over,
})

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })

interface Call { method: string; url: string; body?: unknown }

function stubServer(opts: { mode?: 'server' | 'client'; switched?: boolean; repairedBranches?: unknown } = {}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = new URL(String(url)).pathname
    calls.push({ method, url: path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    if (method === 'GET' && path === '/api/workspaces') {
      return ok([{ id: 'ws-1', slug: 'gh/acme/docs', name: 'docs', repoUrl: 'https://github.com/acme/docs', syncMode: opts.mode ?? 'server' }])
    }
    if (method === 'GET' && path === '/api/workspaces/by-slug/gh/acme/docs') {
      return ok({ workspace: { id: 'ws-1' } })
    }
    if (method === 'GET' && path === '/api/workspaces/ws-1/sync') {
      return ok({
        syncMode: opts.mode ?? 'server',
        repository: 'acme/docs',
        credential: { source: 'oauth', installationAccount: null, holder: { id: 'u1', name: 'Ada', githubLogin: 'ada' } },
        canManagePolicy: true,
      })
    }
    if (method === 'POST' && path === '/api/workspaces/ws-1/sync-mode') {
      return ok({
        syncMode: 'client', switched: opts.switched ?? true, checkpoints: 1, prunedBranches: 2,
        ...(opts.repairedBranches !== undefined ? { repairedBranches: opts.repairedBranches } : {}),
      })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  }))
  return calls
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST')

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>
const stdout = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
const stderr = () => errSpy.mock.calls.map((c) => c.join(' ')).join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  mockDetect.mockReturnValue({ type: 'none' })
  mockLocal.mockReturnValue(null)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  setTTY(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  logSpy.mockRestore()
  errSpy.mockRestore()
})

describe('margins sync-mode push', () => {
  it('switched:true — states the consequences, switches, and says so in push words', async () => {
    const calls = stubServer()

    await handleSyncMode(cfg(), 'push', 'acme/docs', { yes: true })

    expect(posts(calls)).toEqual([{ method: 'POST', url: '/api/workspaces/ws-1/sync-mode', body: { syncMode: 'client' } }])
    expect(stderr()).toContain('Margins stops pulling acme/docs from GitHub.')
    expect(stderr()).toContain('Content stays as it is until the first push.')
    expect(stdout()).toBe(
      'Switched acme/docs to push. Margins no longer pulls it from GitHub; content stays as it is until the first push.',
    )
    expect(`${stdout()}\n${stderr()}`).not.toMatch(/\b(server|client)\b/i)
  })

  it('switched:false — idempotent output, and no prompt for a workspace that already pushes', async () => {
    setTTY(true)
    const calls = stubServer({ mode: 'client', switched: false })

    await handleSyncMode(cfg(), 'push', 'acme/docs', {})

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(posts(calls)).toHaveLength(1)
    expect(stdout()).toBe('acme/docs is already pushed to Margins — nothing was changed.')
  })

  it('--json says push, not the API value, and carries the switch result', async () => {
    stubServer()

    await handleSyncMode(cfg({ json: true }), 'push', 'acme/docs', { yes: true })

    expect(JSON.parse(stdout())).toEqual({
      workspaceId: 'ws-1', repository: 'acme/docs', syncMode: 'push', switched: true, checkpoints: 1, prunedBranches: 2,
    })
  })

  it('already pushed, with repaired branches: says what was repaired instead of "nothing was changed"', async () => {
    stubServer({ mode: 'client', switched: false, repairedBranches: ['main'] })

    await handleSyncMode(cfg(), 'push', 'acme/docs', {})

    expect(stdout()).toBe(
      'acme/docs is already pushed to Margins. Repaired the head of main so pushes to it are accepted again.',
    )
  })

  it('already pushed, several repaired branches are all named', async () => {
    stubServer({ mode: 'client', switched: false, repairedBranches: ['main', 'docs'] })

    await handleSyncMode(cfg(), 'push', 'acme/docs', {})

    expect(stdout()).toBe(
      'acme/docs is already pushed to Margins. Repaired the heads of main and docs so pushes to them are accepted again.',
    )
  })

  it('already pushed, an empty repairedBranches keeps the plain wording', async () => {
    stubServer({ mode: 'client', switched: false, repairedBranches: [] })

    await handleSyncMode(cfg(), 'push', 'acme/docs', {})

    expect(stdout()).toBe('acme/docs is already pushed to Margins — nothing was changed.')
  })

  it('--json includes repairedBranches as the server returned it', async () => {
    stubServer({ mode: 'client', switched: false, repairedBranches: ['main'] })

    await handleSyncMode(cfg({ json: true }), 'push', 'acme/docs', {})

    expect(JSON.parse(stdout())).toEqual({
      workspaceId: 'ws-1', repository: 'acme/docs', syncMode: 'push', switched: false,
      checkpoints: 1, prunedBranches: 2, repairedBranches: ['main'],
    })
  })

  it('prompts at a terminal; declining switches nothing', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(false)
    const calls = stubServer()

    await handleSyncMode(cfg(), 'push', 'acme/docs', {})

    expect(mockConfirm).toHaveBeenCalledTimes(1)
    expect(posts(calls)).toEqual([])
    expect(stderr()).toMatch(/Cancelled — nothing was changed/)
  })

  it('prompts at a terminal; accepting switches', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true)
    const calls = stubServer()

    await handleSyncMode(cfg(), 'push', 'acme/docs', {})

    expect(posts(calls)).toHaveLength(1)
  })

  it('refuses without --yes when it cannot ask', async () => {
    const calls = stubServer()

    await expect(handleSyncMode(cfg(), 'push', 'acme/docs', {}))
      .rejects.toThrow(/not interactive.*nothing was changed\. Re-run with --yes/)
    expect(posts(calls)).toEqual([])
  })

  it('resolves a slug, and with no argument the folder\'s .margins.json, then its origin', async () => {
    let calls = stubServer()
    await handleSyncMode(cfg(), 'push', 'gh/acme/docs', { yes: true })
    expect(calls.some((c) => c.url === '/api/workspaces/by-slug/gh/acme/docs')).toBe(true)
    expect(posts(calls)).toHaveLength(1)

    mockLocal.mockReturnValue({ workspace_id: 'ws-1', workspace_slug: 'gh/acme/docs' })
    calls = stubServer()
    await handleSyncMode(cfg(), 'push', undefined, { yes: true })
    expect(posts(calls)).toHaveLength(1)

    mockLocal.mockReturnValue(null)
    mockDetect.mockReturnValue({ type: 'github', owner: 'acme', repo: 'docs' })
    calls = stubServer()
    await handleSyncMode(cfg(), 'push', undefined, { yes: true })
    expect(posts(calls)).toHaveLength(1)
  })

  it('refuses a switch back to pull, and an unknown mode, before any request', async () => {
    const calls = stubServer()
    await expect(handleSyncMode(cfg(), 'pull', 'acme/docs', { yes: true }))
      .rejects.toThrow(/back to pull from GitHub is not available yet/)
    await expect(handleSyncMode(cfg(), 'server', 'acme/docs', { yes: true }))
      .rejects.toThrow(/back to pull from GitHub is not available yet/)
    await expect(handleSyncMode(cfg(), 'sideways', 'acme/docs', { yes: true }))
      .rejects.toThrow('Unknown sync mode "sideways". Use: margins sync-mode push')
    expect(calls).toEqual([])
  })

  it('no longer accepts `client`, and names the command that replaced it', async () => {
    const calls = stubServer()
    await expect(handleSyncMode(cfg(), 'client', 'acme/docs', { yes: true }))
      .rejects.toThrow('Unknown sync mode "client". Use: margins sync-mode push')
    expect(calls).toEqual([])
  })
})

describe('margins sync-mode push — target resolution and fallbacks', () => {
  it('a workspace UUID is used as is, with no listing or slug lookup', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === `/api/workspaces/${id}/sync-mode`) return ok({ switched: true })
      if (path === `/api/workspaces/${id}/sync`) {
        return ok({ syncMode: 'server', repository: 'acme/docs', credential: { source: 'none', installationAccount: null, holder: null }, canManagePolicy: true })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
    await handleSyncMode(cfg(), 'push', id, { yes: true })
    expect(calls).toEqual([`GET /api/workspaces/${id}/sync`, `POST /api/workspaces/${id}/sync-mode`])
  })

  it('a GitHub URL resolves by repo', async () => {
    const calls = stubServer()
    await handleSyncMode(cfg(), 'push', 'https://github.com/acme/docs.git', { yes: true })
    expect(calls.some((c) => c.url === '/api/workspaces')).toBe(true)
    expect(posts(calls)).toHaveLength(1)
  })

  it('a repo with no workspace is refused before any write', async () => {
    const calls = stubServer()
    await expect(handleSyncMode(cfg(), 'push', 'acme/nothing', { yes: true }))
      .rejects.toThrow(/No workspace you are a member of is connected to acme\/nothing/)
    expect(posts(calls)).toEqual([])
  })

  it('no argument, no .margins.json, no GitHub origin: refused with the remedy', async () => {
    const calls = stubServer()
    await expect(handleSyncMode(cfg(), 'push', undefined, { yes: true }))
      .rejects.toThrow(/No workspace to switch\. Pass one/)
    expect(calls).toEqual([])
  })

  it('an unreachable status read falls back to the target label and the generic access line', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/workspaces/by-slug/gh/acme/docs') return ok({ workspace: { id: 'ws-1' } })
      if (path === '/api/workspaces/ws-1/sync') return new Response('oops', { status: 500 })
      if (init?.method === 'POST') return ok({ switched: true })
      throw new Error(`Unexpected request: ${path}`)
    }))
    await handleSyncMode(cfg(), 'push', 'gh/acme/docs', { yes: true })
    expect(stderr()).toContain('Switching gh/acme/docs to push:')
    expect(stderr()).toContain('The GitHub access Margins uses for this workspace is removed from it.')
    expect(stdout()).toMatch(/^Switched gh\/acme\/docs to push\./)
  })

  it('--json without --yes is refused even at a terminal, and prints no consequences', async () => {
    setTTY(true)
    const calls = stubServer()
    await expect(handleSyncMode(cfg({ json: true }), 'push', 'acme/docs', {}))
      .rejects.toThrow(/not interactive/)
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(stderr()).toBe('')
    expect(posts(calls)).toEqual([])
  })

  it('a refused switch surfaces the mapped message', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/workspaces') {
        return ok([{ id: 'ws-1', slug: 'gh/acme/docs', name: 'docs', repoUrl: 'https://github.com/acme/docs', syncMode: 'server' }])
      }
      if (path === '/api/workspaces/ws-1/sync') return new Response('x', { status: 500 })
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'SYNC_IN_PROGRESS' }), { status: 409 })
      }
      throw new Error(`Unexpected request: ${path}`)
    }))
    await expect(handleSyncMode(cfg(), 'push', 'acme/docs', { yes: true }))
      .rejects.toThrow(/A sync is running .* nothing was changed/)
    expect(stdout()).toBe('')
  })
})

describe('mapSwitchError', () => {
  it('409 SYNC_IN_PROGRESS → retry later, nothing changed', () => {
    expect(mapSwitchError(new ConflictError('x', 'SYNC_IN_PROGRESS')).message)
      .toMatch(/A sync is running .* Try again in a minute — nothing was changed/)
  })

  it('403 → the creator-only refusal (server wording wins when present)', () => {
    expect(mapSwitchError(new ForbiddenError('p', 'FORBIDDEN')).message)
      .toMatch(/Only the workspace creator can change how it syncs/)
    expect(mapSwitchError(new ForbiddenError('p', 'FORBIDDEN', 'Server says no.')).message)
      .toMatch(/Server says no\./)
  })

  it('422 BLOCKED and NOT_APPLICABLE surface the server reason', () => {
    expect(mapSwitchError(new ServerError(422, 'SYNC_MODE_SWITCH_BLOCKED', '"a.png" is not markdown')).message)
      .toMatch(/"a\.png" is not markdown/)
    expect(mapSwitchError(new ServerError(422, 'SYNC_MODE_SWITCH_NOT_APPLICABLE')).message)
      .toMatch(/Only a workspace connected to a GitHub repository/)
  })

  it('404 with no code is an older server; with a code, a missing workspace', () => {
    expect(mapSwitchError(new NotFoundError('p')).message).toMatch(/Upgrade the server/)
    expect(mapSwitchError(new NotFoundError('p', 'NOT_FOUND')).message).toMatch(/Workspace not found/)
  })
})

describe('margins sync-mode push — the local .margins.json', () => {
  it.each(['server', 'pull', 'client'])('after a switch, the folder\'s file bound to that workspace says "push" (was %s)', async (was) => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sm-')))
    const cwd = process.cwd()
    try {
      const file = path.join(dir, '.margins.json')
      fs.writeFileSync(file, JSON.stringify({ workspace_id: 'ws-1', syncMode: was }))
      fs.mkdirSync(path.join(dir, 'sub'))
      process.chdir(path.join(dir, 'sub')) // found by walking up, like every other reader
      stubServer()

      await handleSyncMode(cfg(), 'push', 'acme/docs', { yes: true })

      expect(JSON.parse(fs.readFileSync(file, 'utf8')).syncMode).toBe('push')
      // One line, whichever word the file held.
      expect(errSpy.mock.calls.filter((c) => /Updated .*\.margins\.json/.test(String(c[0])))).toHaveLength(1)
      expect(stderr()).toMatch(/Updated .*\.margins\.json to "syncMode": "push" — commit it\./)
    } finally {
      process.chdir(cwd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a file bound to a different workspace is left alone', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sm-')))
    const cwd = process.cwd()
    try {
      const file = path.join(dir, '.margins.json')
      fs.writeFileSync(file, JSON.stringify({ workspace_id: 'ws-other', syncMode: 'server' }))
      process.chdir(dir)
      stubServer()

      await handleSyncMode(cfg(), 'push', 'acme/docs', { yes: true })

      expect(JSON.parse(fs.readFileSync(file, 'utf8')).syncMode).toBe('server')
    } finally {
      process.chdir(cwd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
