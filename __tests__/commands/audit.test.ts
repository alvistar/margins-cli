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
    getFileContent: vi.fn(),
    getLatestReleaseTag: vi.fn(),
    listTags: vi.fn(),
    getTagSha: vi.fn(),
  }
})

import * as gh from '../../src/lib/gh.js'
import { GhError } from '../../src/lib/gh.js'
import { handleAudit, parseActionPin, evaluatePin, toCsv, ACTION_REPO } from '../../src/commands/audit.js'

const mocked = vi.mocked(gh)

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LATEST_TAG = 'v1.4.0'
const LATEST_SHA = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'
const OLD_SHA = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222'

const cfg = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  apiKey: 'mrgn_testkey123',
  serverUrl: 'https://margins.test',
  json: false,
  verbose: false,
  noColor: false,
  ...overrides,
})

const workflowWith = (ref: string): string => `name: Margins sync
permissions:
  id-token: write
jobs:
  sync:
    steps:
      - uses: actions/checkout@v4
      - uses: ${ACTION_REPO}@${ref}
        with:
          server-url: "https://margins.test"
`

const repoInfo = (over: Partial<gh.RepoInfo> = {}): gh.RepoInfo => ({
  id: 12345,
  ownerId: 777,
  fullName: 'acme/docs',
  defaultBranch: 'main',
  ...over,
})

// Mirrors the server's /api/workspaces list serialization
// (margins listWorkspacesService) — the drift check reads `defaultBranch`,
// which is what the server actually sends (NOT `branch`).
interface Ws {
  id: string
  slug: string
  name: string
  description: string | null
  source: 'github' | 'local'
  repoUrl: string | null
  defaultBranch: string
  syncMode: 'server' | 'client'
  lastSyncedAt: string | null
  documentCount: number
  openDiscussionCount: number
  recentDiscussionCount: number
  lastDiscussionAt: string | null
  isPinned: boolean
}

interface Binding {
  githubRepoId: number
  repositoryOwnerId: number
  boundRepoName: string
  enforcedAt: string | null
  override: boolean
}

interface ServerState {
  workspaces: Ws[]
  bindings: Record<string, Binding | null>
}

const apiOk = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), { status })

/** Stub global fetch with a read-only Margins server fake. */
function stubServer(state: ServerState): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = new URL(String(url))
    if (u.pathname === '/api/workspaces') return apiOk(state.workspaces)
    const bindingMatch = /^\/api\/workspaces\/([^/]+)\/binding$/.exec(u.pathname)
    if (bindingMatch) return apiOk({ binding: state.bindings[bindingMatch[1]!] ?? null })
    throw new Error(`Unexpected request: ${u.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const boundWorkspace = (over: Partial<Ws> = {}): ServerState => ({
  workspaces: [{
    id: 'ws-1', slug: 'acme/docs', name: 'docs', description: null, source: 'github',
    repoUrl: 'https://github.com/acme/docs', defaultBranch: 'main', syncMode: 'client',
    lastSyncedAt: null, documentCount: 1, openDiscussionCount: 0,
    recentDiscussionCount: 0, lastDiscussionAt: null, isPinned: false,
    ...over,
  }],
  bindings: {
    'ws-1': { githubRepoId: 12345, repositoryOwnerId: 777, boundRepoName: 'acme/docs', enforcedAt: null, override: false },
  },
})

function ghDefaults(): void {
  mocked.getRepo.mockResolvedValue(repoInfo())
  mocked.listTree.mockResolvedValue({
    entries: [
      { path: 'README.md', size: 120 },
      { path: 'img/logo.png', size: 2048 },
      // The tree gates the workflow-content fetch: list the file so audit reads it.
      { path: '.github/workflows/margins-sync.yml', size: 900 },
    ],
    truncated: false,
  })
  mocked.listOrgRepos.mockResolvedValue([])
  mocked.getFileContent.mockResolvedValue(workflowWith('v1'))
  mocked.getLatestReleaseTag.mockResolvedValue(LATEST_TAG)
  mocked.listTags.mockResolvedValue([LATEST_TAG])
  mocked.getTagSha.mockResolvedValue(LATEST_SHA)
}

let logSpy: ReturnType<typeof vi.spyOn>

function output(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
}

/** Rows from the --json output shape. */
async function auditRows(
  config: ResolvedConfig,
  target: string | undefined,
  opts: Parameters<typeof handleAudit>[2] = {},
): Promise<Array<{ repo: string; status: string; detail: string }>> {
  await handleAudit({ ...config, json: true }, target, opts)
  const parsed = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as {
    results: Array<{ repo: string; status: string; detail: string }>
  }
  return parsed.results
}

beforeEach(() => {
  vi.clearAllMocks()
  ghDefaults()
  stubServer(boundWorkspace())
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  logSpy.mockRestore()
  process.exitCode = 0
})

// ─── Pin parsing + evaluation (unit) ──────────────────────────────────────────

describe('parseActionPin', () => {
  it('detects tag and SHA pin forms', () => {
    expect(parseActionPin(workflowWith('v1'))).toBe('v1')
    expect(parseActionPin(workflowWith('v1.2.0'))).toBe('v1.2.0')
    expect(parseActionPin(workflowWith(OLD_SHA))).toBe(OLD_SHA)
    expect(parseActionPin(`${workflowWith(OLD_SHA)} # v1.2.0`)).toBe(OLD_SHA)
  })

  it('returns null when no margins-sync-action uses line exists', () => {
    expect(parseActionPin('jobs:\n  steps:\n    - uses: actions/checkout@v4\n')).toBeNull()
  })
})

describe('evaluatePin', () => {
  const latest = { tag: LATEST_TAG, sha: LATEST_SHA }

  it('old tag → stale, naming the latest', () => {
    expect(evaluatePin('v1.2.0', latest)).toEqual({ stale: true, detail: `stale pin: v1.2.0 (latest ${LATEST_TAG})` })
  })

  it('floating major matching latest → current; older major → stale', () => {
    expect(evaluatePin('v1', latest).stale).toBe(false)
    expect(evaluatePin('v1', { tag: 'v2.0.0', sha: null }).stale).toBe(true)
  })

  it('exact latest tag → current', () => {
    expect(evaluatePin(LATEST_TAG, latest).stale).toBe(false)
  })

  it('SHA matching the latest tag SHA → current', () => {
    const r = evaluatePin(LATEST_SHA, latest)
    expect(r.stale).toBe(false)
    expect(r.detail).toContain(LATEST_TAG)
  })

  it('old SHA with latest SHA known → stale', () => {
    const r = evaluatePin(OLD_SHA, latest)
    expect(r.stale).toBe(true)
    expect(r.detail).toContain(LATEST_TAG)
  })

  it('SHA with unresolvable latest SHA → reported as sha-pinned, no staleness verdict', () => {
    const r = evaluatePin(OLD_SHA, { tag: LATEST_TAG, sha: null })
    expect(r.stale).toBe(false)
    expect(r.detail).toContain('cannot compare locally')
  })

  it('unknown latest → pin reported as-is, no staleness verdict', () => {
    const r = evaluatePin('v1.2.0', null)
    expect(r.stale).toBe(false)
    expect(r.detail).toContain('latest unknown')
  })
})

// ─── handleAudit statuses ─────────────────────────────────────────────────────

describe('handleAudit', () => {
  it('repo with no workflow → missing', async () => {
    mocked.getFileContent.mockResolvedValue(null)
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows).toEqual([{
      repo: 'acme/docs',
      status: 'missing',
      detail: 'no .github/workflows/margins-sync.yml on main',
    }])
  })

  it('current floating pin, matching binding, under caps → ok', async () => {
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.detail).toContain('pinned to v1')
    expect(rows[0]!.detail).toContain('2 syncable files')
  })

  it('old tag pin → stale-pin naming the latest version', async () => {
    mocked.getFileContent.mockResolvedValue(workflowWith('v1.2.0'))
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('stale-pin')
    expect(rows[0]!.detail).toContain(`stale pin: v1.2.0 (latest ${LATEST_TAG})`)
  })

  it('old SHA pin → stale-pin when the latest tag SHA resolves', async () => {
    mocked.getFileContent.mockResolvedValue(workflowWith(OLD_SHA))
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('stale-pin')
    expect(rows[0]!.detail).toContain(`latest ${LATEST_TAG}`)
  })

  it('SHA pin with unresolvable latest SHA → ok with "cannot compare locally"', async () => {
    mocked.getFileContent.mockResolvedValue(workflowWith(OLD_SHA))
    mocked.getTagSha.mockResolvedValue(null)
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.detail).toContain('cannot compare locally')
  })

  it('gh failure resolving the latest release → pins reported as-is, no staleness verdict', async () => {
    mocked.getFileContent.mockResolvedValue(workflowWith('v1.2.0'))
    mocked.getLatestReleaseTag.mockRejectedValue(new GhError('boom (HTTP 500)', 500))
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.detail).toContain('pinned to v1.2.0 (latest unknown)')
  })

  it('falls back to the tags list when there is no release', async () => {
    mocked.getFileContent.mockResolvedValue(workflowWith('v1.2.0'))
    mocked.getLatestReleaseTag.mockResolvedValue(null)
    mocked.listTags.mockResolvedValue([LATEST_TAG, 'v1.3.0'])
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('stale-pin')
    expect(rows[0]!.detail).toContain(`latest ${LATEST_TAG}`)
  })

  it('renamed repo → binding-drift naming the rename', async () => {
    const state = boundWorkspace({ repoUrl: 'https://github.com/acme/documentation' })
    state.bindings['ws-1']!.boundRepoName = 'acme/docs'
    stubServer(state)
    mocked.getRepo.mockResolvedValue(repoInfo({ fullName: 'acme/documentation' }))

    const rows = await auditRows(cfg(), 'acme/documentation')
    expect(rows[0]!.status).toBe('binding-drift')
    expect(rows[0]!.detail).toContain('renamed: bound acme/docs, now acme/documentation')
  })

  it('owner id change → transfer drift', async () => {
    const state = boundWorkspace()
    state.bindings['ws-1']!.repositoryOwnerId = 999
    stubServer(state)

    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('binding-drift')
    expect(rows[0]!.detail).toContain('transferred: owner id changed')
  })

  it('default branch change → drift naming old → new', async () => {
    stubServer(boundWorkspace({ defaultBranch: 'main' }))
    mocked.getRepo.mockResolvedValue(repoInfo({ defaultBranch: 'trunk' }))

    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('binding-drift')
    expect(rows[0]!.detail).toContain('default branch changed: main → trunk')
  })

  it('repo id change → binding-drift "repo id changed"', async () => {
    const state = boundWorkspace()
    state.bindings['ws-1']!.githubRepoId = 99999
    stubServer(state)

    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('binding-drift')
    expect(rows[0]!.detail).toContain('repo id changed (bound 99999, now 12345)')
  })

  it('workflow present but no margins-sync-action pin → error row', async () => {
    mocked.getFileContent.mockResolvedValue(
      'jobs:\n  sync:\n    steps:\n      - uses: actions/checkout@v4\n',
    )
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('error')
    expect(rows[0]!.detail).toContain(`workflow present but no ${ACTION_REPO} pin found`)
    expect(process.exitCode).toBe(1)
  })

  it('workspace-list fetch failure with auth set → drift skipped note, other statuses still produced', async () => {
    // Margins auth IS configured, but the server 500s on /api/workspaces:
    // the run degrades to gh-only mode instead of aborting.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/api/workspaces') {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL' } }), { status: 500 })
      }
      throw new Error(`Unexpected request: ${u.pathname}`)
    }))
    mocked.getFileContent.mockResolvedValue(workflowWith('v1.2.0'))

    await handleAudit({ ...cfg(), json: true }, 'acme/docs', {})
    const parsed = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as {
      note?: string
      results: Array<{ repo: string; status: string }>
    }
    expect(parsed.note).toContain('binding checks skipped')
    expect(parsed.results[0]!.status).toBe('stale-pin')
  })

  it('truncated tree listing → over-cap with "tree listing truncated"', async () => {
    mocked.listTree.mockResolvedValue({
      entries: [
        { path: 'README.md', size: 10 },
        { path: '.github/workflows/margins-sync.yml', size: 900 },
      ],
      truncated: true,
    })
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('over-cap')
    expect(rows[0]!.detail).toContain('tree listing truncated')
  })

  it('over-cap repo → flagged with counts', async () => {
    mocked.listTree.mockResolvedValue({
      entries: [
        { path: '.github/workflows/margins-sync.yml', size: 900 },
        ...Array.from({ length: 1001 }, (_, i) => ({ path: `docs/f${i}.md`, size: 10 })),
      ],
      truncated: false,
    })
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('over-cap')
    expect(rows[0]!.detail).toContain('1001 syncable files')
    expect(rows[0]!.detail).toContain('max 1000')
  })

  it('oversized blob → over-cap naming the blob', async () => {
    mocked.listTree.mockResolvedValue({
      entries: [
        { path: 'README.md', size: 10 },
        { path: 'big.png', size: 3 * 1024 * 1024 },
        { path: '.github/workflows/margins-sync.yml', size: 900 },
      ],
      truncated: false,
    })
    const rows = await auditRows(cfg(), 'acme/docs')
    expect(rows[0]!.status).toBe('over-cap')
    expect(rows[0]!.detail).toContain('big.png')
  })

  it('gh-only mode (no margins auth): drift skipped with a note, other checks still run', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('must not call the margins server') })
    vi.stubGlobal('fetch', fetchMock)
    mocked.getFileContent.mockResolvedValue(workflowWith('v1.2.0'))

    await handleAudit(cfg({ apiKey: undefined }), 'acme/docs', {})

    expect(fetchMock).not.toHaveBeenCalled()
    expect(output()).toContain('binding checks skipped (no margins auth)')
    expect(output()).toContain('stale-pin')
  })

  it('gh-only mode still reports missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no server') }))
    mocked.getFileContent.mockResolvedValue(null)
    const rows = await auditRows(cfg({ apiKey: undefined }), 'acme/docs')
    expect(rows[0]!.status).toBe('missing')
  })

  it('per-repo gh error → error row; --org run continues; exit code 1', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.listOrgRepos.mockResolvedValue(['acme/broken', 'acme/docs'])
    mocked.getRepo.mockImplementation(async (name) => {
      if (name === 'acme/broken') throw new GhError('Not Found (HTTP 404)', 404)
      return repoInfo()
    })

    const rows = await auditRows(cfg(), undefined, { org: 'acme' })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ repo: 'acme/broken', status: 'error' })
    expect(rows[0]!.detail).toContain('Not Found')
    expect(rows[1]!.repo).toBe('acme/docs')
    expect(rows[1]!.status).not.toBe('error')
    expect(process.exitCode).toBe(1)
  })

  it('--org aggregates multiple repos with include/exclude filters', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.listOrgRepos.mockResolvedValue(['acme/docs', 'acme/api-docs', 'acme/infra'])
    mocked.getRepo.mockImplementation(async (name) => repoInfo({ fullName: name }))

    const rows = await auditRows(cfg(), undefined, { org: 'acme', include: ['*docs*'], exclude: ['api-*'] })
    expect(rows.map((r) => r.repo)).toEqual(['acme/docs'])
  })

  it('resolves the latest release once per run, not per repo', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.listOrgRepos.mockResolvedValue(['acme/a', 'acme/b', 'acme/c'])
    mocked.getRepo.mockImplementation(async (name) => repoInfo({ fullName: name }))

    await auditRows(cfg(), undefined, { org: 'acme' })
    expect(mocked.getLatestReleaseTag).toHaveBeenCalledTimes(1)
    expect(mocked.getTagSha).toHaveBeenCalledTimes(1)
  })

  it('renders a human table with a summary line', async () => {
    await handleAudit(cfg(), 'acme/docs', {})
    expect(output()).toContain('Repo')
    expect(output()).toContain('Status')
    expect(output()).toContain('acme/docs')
    expect(output()).toContain(`1 ok (latest action: ${LATEST_TAG})`)
  })

  it('requires a target or --org', async () => {
    await expect(handleAudit(cfg(), undefined, {})).rejects.toThrow('Specify a repo')
  })
})

// ─── CSV output ───────────────────────────────────────────────────────────────

describe('CSV output', () => {
  it('toCsv quotes fields containing commas and doubles embedded quotes', () => {
    const csv = toCsv([
      { repo: 'acme/docs', status: 'binding-drift', detail: 'renamed: bound acme/docs, now acme/documentation' },
      { repo: 'acme/api', status: 'ok', detail: 'pinned to "v1"' },
    ])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('repo,status,detail')
    expect(lines[1]).toBe('acme/docs,binding-drift,"renamed: bound acme/docs, now acme/documentation"')
    expect(lines[2]).toBe('acme/api,ok,"pinned to ""v1"""')
  })

  it('--csv prints a parseable CSV including all rows', async () => {
    stubServer({ workspaces: [], bindings: {} })
    mocked.listOrgRepos.mockResolvedValue(['acme/docs', 'acme/legacy'])
    mocked.getRepo.mockImplementation(async (name) => repoInfo({ fullName: name }))
    mocked.getFileContent.mockImplementation(async (fullName) =>
      fullName === 'acme/legacy' ? null : workflowWith('v1'))

    await handleAudit(cfg(), undefined, { org: 'acme', csv: true })

    const lines = output().trim().split('\n')
    expect(lines[0]).toBe('repo,status,detail')
    expect(lines).toHaveLength(3)
    // Each data row parses: unquoted simple fields split cleanly on commas
    const statuses = lines.slice(1).map((l) => l.split(',')[1])
    expect(statuses).toContain('missing')
  })
})
