import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ResolvedConfig } from '../../src/lib/config.js'

// ─── gh wrapper mock (all GitHub access goes through src/lib/gh.ts) ──────────

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

// ─── @clack/prompts + git-remote boundary mocks (origin auto-detection) ──────

const { mockConfirm, mockDetect } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockDetect: vi.fn(),
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

import * as gh from '../../src/lib/gh.js'
import { GhError } from '../../src/lib/gh.js'
import { handleInstall } from '../../src/commands/install.js'
import { normalizeTarget, filterRepos } from '../../src/lib/repo-targets.js'
import { MARGINS_SYNC_TEMPLATE, stampTemplate } from '../../src/templates/margins-sync.js'

const mocked = vi.mocked(gh)

// ─── Config + server fetch mock ───────────────────────────────────────────────

const cfg = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  apiKey: 'mrgn_testkey123',
  serverUrl: 'https://margins.test',
  json: false,
  verbose: false,
  noColor: false,
  ...overrides,
})

interface Ws {
  id: string
  slug: string
  name: string
  repoUrl: string | null
  syncMode: 'server' | 'client'
}

interface Binding {
  githubRepoId: number
  repositoryOwnerId: number
  boundRepoName: string
  enforcedAt: string | null
  override: boolean
}

interface RecordedCall { method: string; url: string; body?: unknown }

interface ServerState {
  workspaces: Ws[]
  bindings: Record<string, Binding | null>
  /** PUT binding responds 409 BINDING_CONFLICT when true. */
  bindingConflict?: boolean
}

const apiOk = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status })

/** Stub global fetch with a Margins server fake; returns the recorded calls. */
function stubServer(state: ServerState): RecordedCall[] {
  const calls: RecordedCall[] = []
  let created = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const u = new URL(String(url))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ method, url: u.pathname, body })

    if (method === 'GET' && u.pathname === '/api/workspaces') {
      return apiOk(state.workspaces)
    }
    if (method === 'POST' && u.pathname === '/api/workspaces') {
      const b = body as { name: string; repoUrl: string }
      const ws: Ws = {
        id: `ws-new-${++created}`, slug: `gh/${b.name}`, name: b.name,
        repoUrl: b.repoUrl, syncMode: 'client',
      }
      state.workspaces.push(ws)
      state.bindings[ws.id] = null
      return apiOk({ workspace: { id: ws.id, slug: ws.slug, name: ws.name } })
    }
    const bindingMatch = /^\/api\/workspaces\/([^/]+)\/binding$/.exec(u.pathname)
    if (bindingMatch) {
      const wsId = bindingMatch[1]!
      if (method === 'GET') return apiOk({ binding: state.bindings[wsId] ?? null })
      if (method === 'PUT') {
        if (state.bindingConflict) {
          return new Response(
            JSON.stringify({ error: { code: 'BINDING_CONFLICT', message: 'Already bound.' } }),
            { status: 409 },
          )
        }
        const b = body as { githubRepoId: number; repositoryOwnerId: number; boundRepoName: string }
        const binding: Binding = { ...b, enforcedAt: null, override: false }
        state.bindings[wsId] = binding
        return apiOk({ binding })
      }
    }
    throw new Error(`Unexpected request: ${method} ${u.pathname}`)
  }))
  return calls
}

const writeCalls = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method !== 'GET')

// ─── gh defaults ──────────────────────────────────────────────────────────────

const repoInfo = (over: Partial<gh.RepoInfo> = {}): gh.RepoInfo => ({
  id: 12345,
  ownerId: 777,
  fullName: 'acme/docs',
  defaultBranch: 'main',
  ...over,
})

function ghDefaults(): void {
  mocked.getRepo.mockResolvedValue(repoInfo())
  mocked.listTree.mockResolvedValue({
    entries: [{ path: 'README.md', size: 120 }, { path: 'img/logo.png', size: 2048 }],
    truncated: false,
  })
  mocked.getFileSha.mockResolvedValue(null)
  mocked.getBranchSha.mockResolvedValue('base-sha')
  mocked.branchExists.mockResolvedValue(false)
  mocked.createBranch.mockResolvedValue(undefined)
  mocked.putFile.mockResolvedValue(undefined)
  mocked.createPullRequest.mockResolvedValue({ url: 'https://github.com/acme/docs/pull/1' })
  mocked.listOrgRepos.mockResolvedValue([])
}

function stampedContent(): string {
  const call = mocked.putFile.mock.calls[0]
  expect(call).toBeDefined()
  return Buffer.from(call![1].contentBase64, 'base64').toString('utf-8')
}

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  ghDefaults()
  mockDetect.mockReturnValue({ type: 'none' }) // default: no origin unless a test sets one
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  logSpy.mockRestore()
  errSpy.mockRestore()
  process.exitCode = 0
})

// ─── Template ─────────────────────────────────────────────────────────────────

describe('margins-sync template', () => {
  it('stamps default branch, server origin, and workspace id', () => {
    const out = stampTemplate({
      defaultBranch: 'develop',
      serverUrl: 'https://margins.test/',
      workspaceId: 'ws-42',
    })
    expect(out).toContain('branches: ["develop"]')
    expect(out).toContain('server-url: "https://margins.test"') // origin, no trailing slash
    expect(out).toContain('workspace-id: "ws-42"')
    expect(out).not.toContain('__DEFAULT_BRANCH__')
    expect(out).not.toContain('__SERVER_URL__')
    expect(out).not.toContain('__WORKSPACE_ID__')
  })

  it('queues instead of cancelling, restricts permissions, retriggers on config changes', () => {
    expect(MARGINS_SYNC_TEMPLATE).toContain('cancel-in-progress: false')
    expect(MARGINS_SYNC_TEMPLATE).toContain('group: margins-sync-${{ github.ref }}')
    expect(MARGINS_SYNC_TEMPLATE).toContain('id-token: write')
    expect(MARGINS_SYNC_TEMPLATE).toContain('contents: read')
    expect(MARGINS_SYNC_TEMPLATE).toContain('".marginsignore"')
    expect(MARGINS_SYNC_TEMPLATE).toContain('".github/workflows/margins-sync.yml"')
    expect(MARGINS_SYNC_TEMPLATE).toContain('workflow_dispatch:')
    expect(MARGINS_SYNC_TEMPLATE).toContain('alvistar/margins-sync-action@v1')
    expect(MARGINS_SYNC_TEMPLATE).toContain('schema-version: 1')
    for (const ext of ['md', 'png', 'jpg', 'jpeg', 'svg', 'gif', 'webp']) {
      expect(MARGINS_SYNC_TEMPLATE).toContain(`"**.${ext}"`)
    }
  })
})

// ─── Target normalization + glob filters ──────────────────────────────────────

describe('normalizeTarget', () => {
  it('accepts owner/repo, https URLs, and ssh remotes', () => {
    expect(normalizeTarget('acme/docs')).toBe('acme/docs')
    expect(normalizeTarget('https://github.com/acme/docs')).toBe('acme/docs')
    expect(normalizeTarget('https://github.com/acme/docs.git')).toBe('acme/docs')
    expect(normalizeTarget('git@github.com:acme/docs.git')).toBe('acme/docs')
  })

  it('rejects garbage', () => {
    expect(() => normalizeTarget('not a repo')).toThrow('Invalid repository target')
  })
})

describe('filterRepos', () => {
  it('applies include then exclude globs against full and short names', () => {
    const repos = ['acme/docs', 'acme/api-docs', 'acme/infra']
    expect(filterRepos(repos, ['*docs*'])).toEqual(['acme/docs', 'acme/api-docs'])
    expect(filterRepos(repos, undefined, ['infra'])).toEqual(['acme/docs', 'acme/api-docs'])
    expect(filterRepos(repos, ['acme/*'], ['api-*'])).toEqual(['acme/docs', 'acme/infra'])
  })
})

// ─── handleInstall ────────────────────────────────────────────────────────────

describe('handleInstall', () => {
  it('single repo happy path: workspace created, binding PUT with gh ids, PR opened, stamped file', async () => {
    const calls = stubServer({ workspaces: [], bindings: {} })

    await handleInstall(cfg(), 'acme/docs', {})

    // Workspace created with the exact body shape
    const create = calls.find((c) => c.method === 'POST' && c.url === '/api/workspaces')
    expect(create?.body).toEqual({
      name: 'docs',
      source: 'github',
      repoUrl: 'https://github.com/acme/docs',
      branch: 'main',
      syncMode: 'client',
    })

    // Binding PUT body matches the gh-sourced immutable ids
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.url).toBe('/api/workspaces/ws-new-1/binding')
    expect(put?.body).toEqual({
      githubRepoId: 12345,
      repositoryOwnerId: 777,
      boundRepoName: 'acme/docs',
    })

    // Workflow PR: branch from default, stamped file, PR opened
    expect(mocked.createBranch).toHaveBeenCalledWith('acme/docs', 'margins/install-sync', 'base-sha')
    const content = stampedContent()
    expect(content).toContain('workspace-id: "ws-new-1"')
    expect(content).toContain('branches: ["main"]')
    expect(content).toContain('cancel-in-progress: false')
    expect(mocked.createPullRequest).toHaveBeenCalledWith('acme/docs', expect.objectContaining({
      head: 'margins/install-sync',
      base: 'main',
    }))
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)
  })

  it('normalizes a full GitHub URL target', async () => {
    stubServer({ workspaces: [], bindings: {} })
    await handleInstall(cfg(), 'https://github.com/acme/docs.git', {})
    expect(mocked.getRepo).toHaveBeenCalledWith('acme/docs')
  })

  it('reuses an existing workspace found by repo URL (no duplicate create)', async () => {
    const calls = stubServer({
      workspaces: [{ id: 'ws-1', slug: 'acme/docs', name: 'docs', repoUrl: 'https://github.com/acme/docs', syncMode: 'client' }],
      bindings: { 'ws-1': null },
    })

    await handleInstall(cfg(), 'acme/docs', {})

    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/workspaces')).toHaveLength(0)
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.url).toBe('/api/workspaces/ws-1/binding')
    expect(mocked.createPullRequest).toHaveBeenCalled()
  })

  it('skips a syncMode conflict, continues the run, and succeeds on rerun after fix', async () => {
    const state: ServerState = {
      workspaces: [
        { id: 'ws-1', slug: 'acme/docs', name: 'docs', repoUrl: 'https://github.com/acme/docs', syncMode: 'server' },
      ],
      bindings: { 'ws-1': null },
    }
    const calls = stubServer(state)
    mocked.listOrgRepos.mockResolvedValue(['acme/docs', 'acme/other'])
    mocked.getRepo.mockImplementation(async (name) =>
      repoInfo(name === 'acme/other' ? { id: 99, ownerId: 777, fullName: 'acme/other' } : {}))

    await handleInstall(cfg(), undefined, { org: 'acme' })

    // Conflicting repo: never bound, no PR
    expect(calls.filter((c) => c.method === 'PUT' && c.url.includes('ws-1'))).toHaveLength(0)
    // Run continued: second repo fully installed
    expect(mocked.createPullRequest).toHaveBeenCalledTimes(1)
    expect(mocked.createPullRequest).toHaveBeenCalledWith('acme/other', expect.anything())
    // Conflict is a skip, not a failure
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)

    // Rerun after the operator migrates the workspace to client sync
    state.workspaces[0]!.syncMode = 'client'
    mocked.createPullRequest.mockClear()
    await handleInstall(cfg(), 'acme/docs', {})
    expect(calls.filter((c) => c.method === 'PUT' && c.url === '/api/workspaces/ws-1/binding')).toHaveLength(1)
    expect(mocked.createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('step-wise resume: binding already set but PR missing → only the PR step acts', async () => {
    const calls = stubServer({
      workspaces: [{ id: 'ws-1', slug: 'acme/docs', name: 'docs', repoUrl: 'https://github.com/acme/docs', syncMode: 'client' }],
      bindings: {
        'ws-1': { githubRepoId: 12345, repositoryOwnerId: 777, boundRepoName: 'acme/docs', enforcedAt: null, override: false },
      },
    })

    await handleInstall(cfg(), 'acme/docs', {})

    expect(writeCalls(calls)).toHaveLength(0) // no workspace create, no binding PUT
    expect(mocked.createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('fully installed repo: all steps no-op', async () => {
    const calls = stubServer({
      workspaces: [{ id: 'ws-1', slug: 'acme/docs', name: 'docs', repoUrl: 'https://github.com/acme/docs', syncMode: 'client' }],
      bindings: {
        'ws-1': { githubRepoId: 12345, repositoryOwnerId: 777, boundRepoName: 'acme/docs', enforcedAt: '2026-06-01T00:00:00Z', override: false },
      },
    })
    // Workflow already on the default branch — the tree listing shows it
    mocked.listTree.mockResolvedValue({
      entries: [
        { path: 'README.md', size: 120 },
        { path: '.github/workflows/margins-sync.yml', size: 900 },
      ],
      truncated: false,
    })

    await handleInstall(cfg(), 'acme/docs', {})

    expect(writeCalls(calls)).toHaveLength(0)
    expect(mocked.createBranch).not.toHaveBeenCalled()
    expect(mocked.putFile).not.toHaveBeenCalled()
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
  })

  it('--dry-run performs zero writes anywhere', async () => {
    const calls = stubServer({ workspaces: [], bindings: {} })

    await handleInstall(cfg(), 'acme/docs', { dryRun: true })

    expect(writeCalls(calls)).toHaveLength(0) // no POST/PUT to the server
    expect(mocked.createBranch).not.toHaveBeenCalled()
    expect(mocked.putFile).not.toHaveBeenCalled()
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
    // Intended actions are printed
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('would create workspace')
    expect(output).toContain('would enable binding')
    expect(output).toContain('would open PR')
  })

  it('skips an over-cap repo (file count) with a reason; run continues', async () => {
    const calls = stubServer({ workspaces: [], bindings: {} })
    mocked.listTree.mockResolvedValue({
      entries: Array.from({ length: 1001 }, (_, i) => ({ path: `docs/f${i}.md`, size: 10 })),
      truncated: false,
    })

    await handleInstall(cfg(), 'acme/docs', {})

    expect(writeCalls(calls)).toHaveLength(0)
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('over server cap')
  })

  it('skips a repo with a blob over the 2 MB cap', async () => {
    const calls = stubServer({ workspaces: [], bindings: {} })
    mocked.listTree.mockResolvedValue({
      entries: [{ path: 'big-diagram.png', size: 3 * 1024 * 1024 }],
      truncated: false,
    })

    await handleInstall(cfg(), 'acme/docs', {})

    expect(writeCalls(calls)).toHaveLength(0)
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
  })

  it('honors a 403 retry-after, then resumes', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.getRepo
      .mockRejectedValueOnce(new GhError('API rate limit exceeded (HTTP 403)', 403, 30))
      .mockResolvedValue(repoInfo())
    const sleep = vi.fn().mockResolvedValue(undefined)

    await handleInstall(cfg(), 'acme/docs', { sleep })

    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(30_000)
    expect(mocked.createPullRequest).toHaveBeenCalledTimes(1) // resumed and finished
  })

  it('stamps a non-main default branch correctly', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.getRepo.mockResolvedValue(repoInfo({ defaultBranch: 'develop' }))

    await handleInstall(cfg(), 'acme/docs', {})

    const content = stampedContent()
    expect(content).toContain('branches: ["develop"]')
    expect(mocked.createPullRequest).toHaveBeenCalledWith('acme/docs', expect.objectContaining({ base: 'develop' }))
  })

  it('binding 409 BINDING_CONFLICT → repo failed, no PR', async () => {
    stubServer({ workspaces: [], bindings: {}, bindingConflict: true })

    await handleInstall(cfg(), 'acme/docs', {})

    expect(mocked.createBranch).not.toHaveBeenCalled()
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('binding conflict')
  })

  it('binding mismatch (workspace bound to another repo) → repo failed, no PR', async () => {
    stubServer({
      workspaces: [{ id: 'ws-1', slug: 'acme/docs', name: 'docs', repoUrl: 'https://github.com/acme/docs', syncMode: 'client' }],
      bindings: {
        'ws-1': { githubRepoId: 555, repositoryOwnerId: 666, boundRepoName: 'evil/docs', enforcedAt: null, override: false },
      },
    })

    await handleInstall(cfg(), 'acme/docs', {})

    expect(mocked.createPullRequest).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('PR creation blocked by permissions → reported as awaiting permissions, exit 0', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.createPullRequest.mockRejectedValue(new GhError('Resource not accessible (HTTP 403)', 403))

    await handleInstall(cfg(), 'acme/docs', {})

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('PR creation blocked, awaiting permissions')
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)
  })

  it('no target, no --org, and no git origin → requires a target', async () => {
    mockDetect.mockReturnValue({ type: 'none' })
    stubServer({ workspaces: [], bindings: {} })
    await expect(handleInstall(cfg(), undefined, {})).rejects.toThrow('Specify a repo')
  })

  it('rejects a target combined with --org (ambiguous — --org must not silently win)', async () => {
    stubServer({ workspaces: [], bindings: {} })
    await expect(handleInstall(cfg(), 'acme/docs', { org: 'acme' }))
      .rejects.toThrow('Specify a repo OR --org, not both')
    expect(mocked.listOrgRepos).not.toHaveBeenCalled()
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
  })

  it('PR 422 "already exists" → installed, exit 0', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.createPullRequest.mockRejectedValue(
      new GhError('A pull request already exists for acme:margins/install-sync (HTTP 422)', 422),
    )

    await handleInstall(cfg(), 'acme/docs', {})

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).toContain('PR already open')
    expect(output).toContain('installed')
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)
  })

  it('resume path: branch + workflow file already on the install branch → putFile skipped, PR still opened', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.branchExists.mockResolvedValue(true)
    mocked.getFileSha.mockResolvedValue('existing-file-sha')

    await handleInstall(cfg(), 'acme/docs', {})

    expect(mocked.createBranch).not.toHaveBeenCalled()
    expect(mocked.putFile).not.toHaveBeenCalled() // file already committed
    expect(mocked.createPullRequest).toHaveBeenCalledTimes(1)
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)
  })

  it('rate-limit 403 at the PR step → waited and retried, not skipped as permissions', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.createPullRequest
      .mockRejectedValueOnce(new GhError('API rate limit exceeded (HTTP 403)', 403, 30))
      .mockResolvedValue({ url: 'https://github.com/acme/docs/pull/2' })
    const sleep = vi.fn().mockResolvedValue(undefined)

    await handleInstall(cfg(), 'acme/docs', { sleep })

    expect(sleep).toHaveBeenCalledWith(30_000)
    expect(mocked.createPullRequest).toHaveBeenCalledTimes(2) // retried after the wait
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(output).not.toContain('awaiting permissions')
    expect(output).toContain('PR opened')
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)
  })
})

// ─── handleInstall — origin auto-detection ────────────────────────────────────

describe('handleInstall — origin auto-detection', () => {
  const githubOrigin = (): void => {
    mockDetect.mockReturnValue({ type: 'github', owner: 'acme', repo: 'docs' })
  }

  it('TTY + confirm accepted → onboards the detected repo, prompt names owner/repo', async () => {
    githubOrigin()
    setTTY(true)
    mockConfirm.mockResolvedValue(true)
    stubServer({ workspaces: [], bindings: {} })

    await handleInstall(cfg(), undefined, {})

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('acme/docs') }),
    )
    expect(mocked.createPullRequest).toHaveBeenCalledWith('acme/docs', expect.anything())
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)
  })

  it('TTY + confirm declined → nothing written, exit 0', async () => {
    githubOrigin()
    setTTY(true)
    mockConfirm.mockResolvedValue(false)
    const calls = stubServer({ workspaces: [], bindings: {} })

    await handleInstall(cfg(), undefined, {})

    expect(writeCalls(calls)).toHaveLength(0)
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)
  })

  it('TTY + confirm cancelled (Ctrl-C) → treated as declined, exit 0', async () => {
    githubOrigin()
    setTTY(true)
    mockConfirm.mockResolvedValue(Symbol.for('clack:cancel'))
    stubServer({ workspaces: [], bindings: {} })

    await handleInstall(cfg(), undefined, {})

    expect(mocked.createPullRequest).not.toHaveBeenCalled()
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true)
  })

  it('non-TTY without --yes → errors naming the detected repo, no prompt, no writes', async () => {
    githubOrigin()
    setTTY(false)
    stubServer({ workspaces: [], bindings: {} })

    await expect(handleInstall(cfg(), undefined, {})).rejects.toThrow('acme/docs')
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
  })

  it('--yes → onboards without prompting even with no TTY', async () => {
    githubOrigin()
    setTTY(false)
    stubServer({ workspaces: [], bindings: {} })

    await handleInstall(cfg(), undefined, { yes: true })

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mocked.createPullRequest).toHaveBeenCalledWith('acme/docs', expect.anything())
  })

  it('--json without --yes → errors (JSON output is non-interactive)', async () => {
    githubOrigin()
    setTTY(true)
    stubServer({ workspaces: [], bindings: {} })

    await expect(handleInstall(cfg({ json: true }), undefined, {})).rejects.toThrow('acme/docs')
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('non-GitHub origin → GitHub-required error surfaces from the command', async () => {
    mockDetect.mockReturnValue({ type: 'other', url: 'https://gitlab.com/acme/docs.git' })
    setTTY(true)
    stubServer({ workspaces: [], bindings: {} })

    await expect(handleInstall(cfg(), undefined, {})).rejects.toThrow(/is not a GitHub repo/)
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mocked.createPullRequest).not.toHaveBeenCalled()
  })

  it('explicit target with --yes → --yes is a no-op, no detection, normal onboarding', async () => {
    setTTY(true)
    stubServer({ workspaces: [], bindings: {} })

    await handleInstall(cfg(), 'acme/docs', { yes: true })

    expect(mockDetect).not.toHaveBeenCalled()
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mocked.createPullRequest).toHaveBeenCalledWith('acme/docs', expect.anything())
  })
})
