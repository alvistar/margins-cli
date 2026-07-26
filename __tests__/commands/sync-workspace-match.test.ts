/**
 * A folder name must not bind a sync to somebody else's workspace.
 *
 * `findExistingWorkspace` matched with `w.slug.toLowerCase().endsWith(name)`, where
 * `name` was the *folder* basename. A repo checked out into `docs/` therefore matched a
 * workspace `gh/someone/internal-docs` — a different owner, a different repo — and the
 * sync bound to it and pushed.
 *
 * That is the same class of harm as the refusal bug this change is mostly about (content
 * landing somewhere nobody intended), reached by a different route, and it is worse in
 * one way: the refusal at least stops, whereas a wrong match succeeds quietly.
 *
 * The fix is not a smarter name match. The GitHub caller already knows the repo's
 * `owner/repo` — the folder name was only ever a proxy for it, and a bad one. Match on
 * repo identity, reusing `findWorkspaceByRepoUrl` from `src/lib/audit-checks.ts`, which
 * already does exactly this correctly for `margins install`. The local-workspace caller,
 * which has no repo, matches its slug's final segment exactly instead of by suffix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

import { handleSync } from '../../src/commands/sync.js'
import type { ResolvedConfig } from '../../src/lib/config.js'

let root: string
let dir: string
let dataDir: string

/** A repo whose folder is literally `docs`, checked out from acme/docs. */
function makeRepo(folder: string, remote: string): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-match-'))
  const d = path.join(root, folder)
  fs.mkdirSync(d)
  execFileSync('git', ['init', '-q'], { cwd: d })
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: d })
  fs.writeFileSync(path.join(d, 'README.md'), '# hello\n')
  return d
}

function cfg(): ResolvedConfig {
  return { apiKey: 'mrgn_test', serverUrl: 'https://margins.test', json: false } as unknown as ResolvedConfig
}

/**
 * A workspace list containing a decoy: same trailing segment, different owner AND
 * different repo. Nothing here belongs to acme/docs.
 */
const DECOY_LIST = [
  {
    id: 'ws-someone-else',
    slug: 'gh/someone/internal-docs',
    name: 'internal-docs',
    repoUrl: 'https://github.com/someone/internal-docs',
    syncMode: 'client',
  },
]

function stubFetch() {
  const bodies: unknown[] = []
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.body) { try { bodies.push(JSON.parse(String(init.body))) } catch { /* non-JSON */ } }
    if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
      posts.push(url)
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      // The github create is refused with a CODELESS 409, so control reaches the
      // lookup under test rather than the SLUG_CONFLICT stop.
      if (body['source'] === 'github') {
        return new Response(JSON.stringify({ message: 'already exists' }), { status: 409 })
      }
      return new Response(JSON.stringify({ workspace: { id: 'ws-local', slug: 'local/u/docs' } }), { status: 200 })
    }
    if (url.includes('/api/workspaces')) {
      return new Response(JSON.stringify(DECOY_LIST), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }))
  return { bodies }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('sync workspace matching', () => {
  beforeEach(() => {
    dir = makeRepo('docs', 'https://github.com/acme/docs.git')
    // Isolate repos.json — see sync-refusal.test.ts for why this matters.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-match-data-'))
    vi.stubEnv('MARGINS_DATA_DIR', dataDir)
  })

  it('does NOT bind a folder named "docs" to gh/someone/internal-docs', async () => {
    const { bodies } = stubFetch()

    await handleSync(cfg(), { dir }).catch(() => { /* later steps may fail; the binding is what matters */ })

    // The decoy shares a trailing segment and nothing else. Binding to it would
    // push this repo's markdown into a stranger's workspace.
    const written = fs.existsSync(path.join(dir, '.margins.json'))
      ? JSON.parse(fs.readFileSync(path.join(dir, '.margins.json'), 'utf8')) as Record<string, unknown>
      : null

    expect(
      written?.['workspace_id'] ?? null,
      'a suffix match must never bind this repo to someone else\'s workspace',
    ).not.toBe('ws-someone-else')

    // And it should have fallen through to creating its own local workspace instead.
    const localCreate = bodies.some((b) =>
      typeof b === 'object' && b !== null && (b as Record<string, unknown>)['source'] === 'local')
    expect(localCreate, 'with no genuine match, the local fallback should run').toBe(true)
  })

  it('still binds when the repo genuinely matches', async () => {
    // The over-refusal control: without it, "never match anything" passes the test
    // above while breaking every legitimate re-sync.
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify({ message: 'already exists' }), { status: 409 })
      }
      if (url.includes('/api/workspaces')) {
        return new Response(JSON.stringify([{
          id: 'ws-acme-docs',
          slug: 'gh/acme/docs',
          name: 'docs',
          repoUrl: 'https://github.com/acme/docs',
          syncMode: 'client',
        }]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }))

    await handleSync(cfg(), { dir }).catch(() => { /* as above */ })

    const written = fs.existsSync(path.join(dir, '.margins.json'))
      ? JSON.parse(fs.readFileSync(path.join(dir, '.margins.json'), 'utf8')) as Record<string, unknown>
      : null
    expect(written?.['workspace_id']).toBe('ws-acme-docs')
  })
})
