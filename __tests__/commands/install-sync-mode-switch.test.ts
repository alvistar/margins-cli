/**
 * `margins install` on a workspace that pulls from GitHub (ai-review#282,
 * user stories 3–5): state what changes, get an acceptance, then switch, bind
 * and open the workflow PR — in that order, and nothing after a failed switch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ResolvedConfig } from '../../src/lib/config.js'

vi.mock('../../src/lib/gh.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/gh.js')>('../../src/lib/gh.js')
  return {
    GhError: actual.GhError,
    getRepo: vi.fn(),
    listTree: vi.fn(),
    listOrgRepos: vi.fn(),
    getFileSha: vi.fn(),
    getBranchSha: vi.fn(),
    branchExists: vi.fn(),
    createBranch: vi.fn(),
    putFile: vi.fn(),
    createPullRequest: vi.fn(),
  }
})

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }))
vi.mock('@clack/prompts', () => ({
  confirm: mockConfirm,
  isCancel: (v: unknown) => v === Symbol.for('clack:cancel'),
}))

import * as gh from '../../src/lib/gh.js'
import { handleInstall } from '../../src/commands/install.js'

const mocked = vi.mocked(gh)

const cfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  apiKey: 'mrgn_testkey123',
  serverUrl: 'https://margins.test',
  json: false,
  verbose: false,
  noColor: false,
  ...over,
})

interface Call { method: string; url: string; body?: unknown }

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
/** The route's real error shape: `apiError()` → `{ error: CODE, message }`. */
const fail = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: code, message }), { status })

interface Server {
  /** Response to POST /sync-mode; default: switched. */
  switchResponse?: () => Response
  /** Response to GET /sync; default: an OAuth holder named Ada. */
  statusResponse?: () => Response
  /** Every request, in order — the test reads the ORDER, not just the set. */
  calls: Call[]
}

function stubServer(over: Partial<Server> = {}): Server {
  const server: Server = { calls: [], ...over }
  let binding: unknown = null
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = new URL(String(url)).pathname
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    server.calls.push({ method, url: path, body })

    if (method === 'GET' && path === '/api/workspaces') {
      return ok([{ id: 'ws-1', slug: 'gh/acme/docs', name: 'docs', repoUrl: 'https://github.com/acme/docs', syncMode: 'server' }])
    }
    if (method === 'GET' && path === '/api/workspaces/ws-1/sync') {
      return server.statusResponse?.() ?? ok({
        syncMode: 'server',
        repository: 'acme/docs',
        credential: { source: 'oauth', installationAccount: null, holder: { id: 'u1', name: 'Ada', githubLogin: 'ada' } },
        canManagePolicy: true,
      })
    }
    if (method === 'POST' && path === '/api/workspaces/ws-1/sync-mode') {
      return server.switchResponse?.() ?? ok({ syncMode: 'client', switched: true, checkpoints: 1, prunedBranches: 0 })
    }
    if (path === '/api/workspaces/ws-1/binding') {
      if (method === 'GET') return ok({ binding })
      binding = { ...(body as object), enforcedAt: null, override: false }
      return ok({ binding })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  }))
  return server
}

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

/** Server writes, in order, tagged by what they are. */
const writes = (s: Server) => s.calls
  .filter((c) => c.method !== 'GET')
  .map((c) => `${c.method} ${c.url}`)

let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>
const stderr = () => errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
const stdout = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  mocked.getRepo.mockResolvedValue({ id: 12345, ownerId: 777, fullName: 'acme/docs', defaultBranch: 'main' })
  mocked.listTree.mockResolvedValue({ entries: [{ path: 'README.md', size: 120 }], truncated: false })
  mocked.getFileSha.mockResolvedValue(null)
  mocked.getBranchSha.mockResolvedValue('base-sha')
  mocked.branchExists.mockResolvedValue(false)
  mocked.createBranch.mockResolvedValue(undefined)
  mocked.putFile.mockResolvedValue(undefined)
  mocked.createPullRequest.mockResolvedValue({ url: 'https://github.com/acme/docs/pull/1' })
  mocked.listOrgRepos.mockResolvedValue([])
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  setTTY(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  logSpy.mockRestore()
  errSpy.mockRestore()
  process.exitCode = 0
})

describe('install on a workspace that pulls — acceptance', () => {
  it('confirmed at the prompt: switch, then bind, then PR, in that order', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true)
    const s = stubServer()

    await handleInstall(cfg(), 'acme/docs', {})

    expect(mockConfirm).toHaveBeenCalledTimes(1)
    expect(writes(s)).toEqual([
      'POST /api/workspaces/ws-1/sync-mode',
      'PUT /api/workspaces/ws-1/binding',
    ])
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ syncMode: 'client' })
    // The PR is the last step, after both server writes.
    expect(mocked.createPullRequest).toHaveBeenCalledTimes(1)
    const prBody = mocked.createPullRequest.mock.calls[0]![1].body
    expect(prBody).toMatch(/switched it to push/)
    expect(stdout()).toMatch(/switched gh\/acme\/docs to push/)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('states every consequence before asking, in pull/push words only', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true)
    stubServer()

    await handleInstall(cfg(), 'acme/docs', {})

    const said = stderr()
    expect(said).toContain('Margins stops pulling acme/docs from GitHub.')
    expect(said).toContain("The GitHub access it uses, Ada's account, is removed from this workspace.")
    expect(said).toContain("Content stays as it is until the workflow's first push.")
    expect(said).toContain('Discussions, documents and history are kept.')
    expect(said).toContain('There is no switch back to pull yet.')
    expect(`${said}\n${stdout()}`).not.toMatch(/\b(server|client)\b/i)
  })

  it('names the GitHub App when that is the access in use', async () => {
    const s = stubServer({
      statusResponse: () => ok({
        syncMode: 'server', repository: 'acme/docs',
        credential: { source: 'installation', installationAccount: 'acme', holder: null },
        canManagePolicy: true,
      }),
    })

    await handleInstall(cfg(), 'acme/docs', { yes: true })

    expect(stderr()).toContain('the Margins GitHub App on acme, is removed')
    expect(writes(s)[0]).toBe('POST /api/workspaces/ws-1/sync-mode')
  })

  it('declined at the prompt: nothing is written and no PR is opened', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(false)
    const s = stubServer()

    await handleInstall(cfg(), 'acme/docs', {})

    expect(writes(s)).toEqual([])
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
    expect(stdout()).toMatch(/switch to push declined/)
  })

  it('--yes switches without a prompt, even with no terminal', async () => {
    const s = stubServer()

    await handleInstall(cfg(), 'acme/docs', { yes: true })

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(writes(s)).toEqual([
      'POST /api/workspaces/ws-1/sync-mode',
      'PUT /api/workspaces/ws-1/binding',
    ])
    expect(mocked.createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('no terminal and no --yes: fails with the remedy (exit 1), switches nothing', async () => {
    const s = stubServer()

    await handleInstall(cfg(), 'acme/docs', {})

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(writes(s)).toEqual([])
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(stdout()).toMatch(/0 installed, 0 skipped, 1 failed/)
    expect(stdout()).toMatch(/needs confirmation: re-run with --yes — nothing was changed/)
  })

  it('--json without --yes is not interactive either', async () => {
    setTTY(true)
    const s = stubServer()

    await handleInstall(cfg({ json: true }), 'acme/docs', {})

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(writes(s)).toEqual([])
    const out = JSON.parse(stdout()) as { results: Array<{ status: string; reason: string }> }
    expect(out.results[0]!.status).toBe('failed')
  })

  it('--dry-run reports the switch it would make and writes nothing', async () => {
    const s = stubServer()

    await handleInstall(cfg(), 'acme/docs', { dryRun: true })

    expect(writes(s)).toEqual([])
    expect(s.calls.some((c) => c.url.endsWith('/sync'))).toBe(false)
    expect(stdout()).toMatch(/would switch gh\/acme\/docs to push/)
  })

  it('an already-switched workspace (switched:false) still binds and opens the PR', async () => {
    const s = stubServer({ switchResponse: () => ok({ syncMode: 'client', switched: false }) })

    await handleInstall(cfg(), 'acme/docs', { yes: true })

    expect(writes(s)).toContain('PUT /api/workspaces/ws-1/binding')
    expect(stdout()).toMatch(/already pushed to Margins/)
    expect(mocked.createPullRequest.mock.calls[0]![1].body).not.toMatch(/switched it to push/)
  })
})

describe('install on a workspace that pulls — a refused switch stops the install', () => {
  const cases: Array<[string, () => Response, RegExp]> = [
    ['409 SYNC_IN_PROGRESS',
      () => fail(409, 'SYNC_IN_PROGRESS', 'A sync is running on this workspace right now. Try again in a minute — nothing was changed.'),
      /A sync is running .* Try again in a minute/],
    ['403 FORBIDDEN',
      () => fail(403, 'FORBIDDEN', 'Only the workspace creator can change how it syncs. It decides what the workspace accepts for everyone.'),
      /Only the workspace creator can change how it syncs/],
    ['422 SYNC_MODE_SWITCH_BLOCKED',
      () => fail(422, 'SYNC_MODE_SWITCH_BLOCKED', '"diagram.png" on branch "main" is not a markdown document. The switch carries markdown only; remove it from the workspace or contact support. Nothing was changed.'),
      /"diagram\.png" on branch "main" is not a markdown document/],
    ['422 SYNC_MODE_SWITCH_NOT_APPLICABLE',
      () => fail(422, 'SYNC_MODE_SWITCH_NOT_APPLICABLE', 'Only a workspace connected to a GitHub repository can switch how it syncs.'),
      /Only a workspace connected to a GitHub repository/],
  ]

  for (const [name, response, message] of cases) {
    it(`${name}: failed with the server's reason, no binding, no PR`, async () => {
      const s = stubServer({ switchResponse: response })

      await handleInstall(cfg(), 'acme/docs', { yes: true })

      expect(writes(s)).toEqual(['POST /api/workspaces/ws-1/sync-mode'])
      expect(mocked.createPullRequest).not.toHaveBeenCalled()
      expect(mocked.putFile).not.toHaveBeenCalled()
      expect(stdout()).toMatch(message)
      expect(stdout()).toMatch(/0 installed, 0 skipped, 1 failed/)
      expect(process.exitCode).toBe(1)
    })
  }

  it('409 without the server message still says nothing changed', async () => {
    stubServer({ switchResponse: () => new Response(JSON.stringify({ error: 'SYNC_IN_PROGRESS' }), { status: 409 }) })

    await handleInstall(cfg(), 'acme/docs', { yes: true })

    expect(stdout()).toMatch(/Try again in a minute — nothing was changed/)
  })

  it('a caller the status read refuses (403) is told before any write', async () => {
    const s = stubServer({ statusResponse: () => fail(403, 'INSUFFICIENT_ROLE', 'Edit access required.') })

    await handleInstall(cfg(), 'acme/docs', { yes: true })

    expect(writes(s)).toEqual([])
    expect(stdout()).toMatch(/Only the workspace creator can change how it syncs/)
    expect(process.exitCode).toBe(1)
  })

  it('--org: one refused switch does not stop the next repo', async () => {
    stubServer({ switchResponse: () => fail(409, 'SYNC_IN_PROGRESS', 'busy') })
    mocked.listOrgRepos.mockResolvedValue(['acme/docs', 'acme/other'])
    mocked.getRepo.mockImplementation(async (name) => name === 'acme/other'
      ? { id: 99, ownerId: 777, fullName: 'acme/other', defaultBranch: 'main' }
      : { id: 12345, ownerId: 777, fullName: 'acme/docs', defaultBranch: 'main' })
    // acme/other has no workspace yet: allow the create + its binding.
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (init?.method === 'POST' && path === '/api/workspaces') {
        return ok({ workspace: { id: 'ws-2', slug: 'gh/acme/other' } })
      }
      if (path === '/api/workspaces/ws-2/binding') return ok({ binding: null })
      return base(url, init)
    }))

    await handleInstall(cfg(), undefined, { org: 'acme', yes: true })

    expect(mocked.createPullRequest).toHaveBeenCalledTimes(1)
    expect(mocked.createPullRequest).toHaveBeenCalledWith('acme/other', expect.anything())
    expect(process.exitCode).toBe(1)
  })
})
