/**
 * A refused workspace create must STOP the sync — not quietly make a different one.
 *
 * Margins 0.60.0 removed auto-join: `POST /api/workspaces` used to treat a colliding
 * repo slug as a *join* and grant the caller `comment` membership on a workspace they
 * were never invited to. A non-member now gets `409 SLUG_CONFLICT` with a message
 * naming the way in (an invite link).
 *
 * This CLI predates that refusal and reads any 409 as "already exists, go find it". The
 * lookup it then runs is backed by the *membership-scoped* workspace listing, so a
 * non-member matches nothing by construction, and control falls through to
 * `createLocalWorkspace`. The repo's markdown lands in a brand-new **private** workspace
 * nobody intended and `.margins.json` is rewritten to point at it. The only signal is a
 * warning behind `if (!isJson)` — so under `--json`, which is how CI runs, there is no
 * signal at all. Someone can then review in a workspace they believe is their team's
 * while their comments are invisible to everyone.
 *
 * ─── What these tests assert, and why it is the request and not the message ──────────
 *
 * The load-bearing assertion is that **no local-workspace create request is issued**.
 * Asserting only on the error message would pass a "fix" that reworded the warning and
 * still created the workspace — which is the exact defect, minus the warning.
 *
 * `fetch` is stubbed rather than the API client, following `__tests__/api-client.test.ts`.
 * That exercises the real `409 → ConflictError.code` chain in `api-client.ts`; mocking the
 * client would assert the mock and prove nothing about `code` surviving the transport,
 * which is the single fact this whole change rests on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

import { handleSync } from '../../src/commands/sync.js'
import type { ResolvedConfig } from '../../src/lib/config.js'

/** The server's real 0.60.0 refusal — token prefix and human guidance, verbatim. */
const SLUG_CONFLICT_BODY = {
  error: 'SLUG_CONFLICT',
  message:
    'SLUG_CONFLICT: A workspace already exists for this repository. ' +
    'Ask an editor to send you an invite link from the Collaborators tab.',
}

let dir: string
let dataDir: string

/** Folder basename is `notes` while the remote is acme/private-docs, so the
 *  repo lookup and the local lookup key on different strings. */
function makeNamedRepo(folder: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-refusal-'))
  const d = path.join(root, folder)
  fs.mkdirSync(d)
  execFileSync('git', ['init', '-q'], { cwd: d })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/private-docs.git'], { cwd: d })
  fs.writeFileSync(path.join(d, 'README.md'), '# hello\n')
  return d
}

function makeRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-refusal-'))
  execFileSync('git', ['init', '-q'], { cwd: d })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/private-docs.git'], { cwd: d })
  fs.writeFileSync(path.join(d, 'README.md'), '# hello\n')
  return d
}

function cfg(json: boolean): ResolvedConfig {
  return {
    apiKey: 'mrgn_test',
    serverUrl: 'https://margins.test',
    json,
  } as unknown as ResolvedConfig
}

/**
 * Record every request so a test can assert on what was NOT sent. `calls` holds
 * `METHOD path` strings; `creates` is the subset that posted a workspace create.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: string[] = []
  const bodies: unknown[] = []
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (init?.body) { try { bodies.push(JSON.parse(String(init.body))) } catch { /* non-JSON */ } }
    return handler(url, init)
  })
  vi.stubGlobal('fetch', mock)
  return { calls, bodies }
}

/** Workspace-create POSTs, by the shape of their body. */
function creates(bodies: unknown[]) {
  return bodies.filter((b): b is Record<string, unknown> =>
    typeof b === 'object' && b !== null && 'name' in b && ('source' in b || 'projectName' in b))
}

function localCreates(bodies: unknown[]) {
  return creates(bodies).filter((b) => b['source'] === 'local' || 'projectName' in b)
}

beforeEach(() => {
  dir = makeRepo()
  // Isolate repos.json. Without this the sync writes into the REAL data dir
  // (~/Library/Application Support/margins/repos.json) — the file margins-desktop's
  // tray app reads — leaving dead /var/folders entries behind on every run.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-sync-refusal-data-'))
  vi.stubEnv('MARGINS_DATA_DIR', dataDir)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('margins sync — a refused workspace create', () => {
  it('stops, and does NOT create a local workspace instead', async () => {
    const { bodies } = stubFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify(SLUG_CONFLICT_BODY), { status: 409 })
      }
      if (url.includes('/api/workspaces')) return new Response('[]', { status: 200 })
      return new Response('{}', { status: 200 })
    })

    await expect(handleSync(cfg(false), { dir })).rejects.toThrow()

    // THE assertion. A reworded warning that still creates the workspace passes
    // every message-shaped check; it does not pass this one.
    expect(
      localCreates(bodies),
      'a refused sync must not fall through to creating a local workspace',
    ).toEqual([])
  })

  it('surfaces the server\'s guidance, not a generic message', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify(SLUG_CONFLICT_BODY), { status: 409 })
      }
      if (url.includes('/api/workspaces')) return new Response('[]', { status: 200 })
      return new Response('{}', { status: 200 })
    })

    const err = await handleSync(cfg(false), { dir }).catch((e: Error) => e)
    const text = `${(err as Error).message} ${(err as { userMessage?: string }).userMessage ?? ''}`
    expect(text).toMatch(/invite link/i)
    expect(text).toMatch(/Collaborators/i)
  })

  it('is not silent under --json — the mode CI runs in', async () => {
    // This is the regression that matters most: today the only signal is a warning
    // wrapped in `if (!isJson)`, so a CI run sees a *successful* sync into the
    // wrong workspace.
    const { bodies } = stubFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify(SLUG_CONFLICT_BODY), { status: 409 })
      }
      if (url.includes('/api/workspaces')) return new Response('[]', { status: 200 })
      return new Response('{}', { status: 200 })
    })

    const err = await handleSync(cfg(true), { dir, json: true }).catch((e: Error) => e)
    expect(localCreates(bodies)).toEqual([])

    // Assert the JSON CONTRACT, not just "it threw". The previous version of
    // this test made the same two assertions as the non-JSON one with the flags
    // flipped, so a change that swallowed the error into a {status:'synced'}
    // line — the exact CI-silence defect — would have left it green.
    const { formatError } = await import('../../src/lib/output.js')
    const envelope = JSON.parse(formatError(err, true)) as { error?: string; code?: string }
    expect(envelope.error, 'the guidance must reach a JSON consumer').toMatch(/invite link/i)
    expect(envelope.code).toBeTruthy()
    expect((err as { exitCode?: number }).exitCode ?? 1).toBeGreaterThan(0)
  })

  it('falls back to our own wording when the server sends a code but no message', async () => {
    // The transport substitutes `Conflict while calling <path>` for a body with
    // no message. Passing that through would print an internal route string at
    // the user in place of the guidance this whole change exists to surface.
    stubFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify({ error: 'SLUG_CONFLICT' }), { status: 409 })
      }
      if (url.includes('/api/workspaces')) return new Response('[]', { status: 200 })
      return new Response('{}', { status: 200 })
    })

    const err = await handleSync(cfg(false), { dir }).catch((e: Error) => e)
    const text = (err as { userMessage?: string }).userMessage ?? (err as Error).message
    expect(text).toMatch(/invite link/i)
    expect(text, 'never surface the transport placeholder').not.toMatch(/Conflict while calling/)
  })

  // ─── The LOCAL matcher — previously unreachable in any test ───────────────

  it('a local create collision does NOT bind a GitHub workspace with the same name', async () => {
    // Reaching findLocalWorkspaceByName needs the REPO lookup to miss first, so the
    // decoy matches the FOLDER name (`notes`) while its repoUrl points elsewhere.
    // Before the repoUrl guard, that decoy satisfied the local lookup and the folder
    // was bound to a stranger's GitHub workspace, decided by server list order.
    const local = makeNamedRepo('notes')
    stubFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify({ message: 'already exists' }), { status: 409 })
      }
      if (url.includes('/api/workspaces')) {
        return new Response(JSON.stringify([
          { id: 'ws-github-decoy', slug: 'gh/other/notes', name: 'notes',
            repoUrl: 'https://github.com/other/notes', syncMode: 'client' },
        ]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })

    await handleSync(cfg(false), { dir: local }).catch(() => { /* nothing legitimate to bind */ })

    const cfgPath = path.join(local, '.margins.json')
    const written = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      : null
    expect(
      written?.['workspace_id'] ?? null,
      'a repo-backed workspace must never satisfy the LOCAL lookup',
    ).not.toBe('ws-github-decoy')
    fs.rmSync(path.dirname(local), { recursive: true, force: true })
  })

  it('still finds a genuine local workspace (over-refusal control)', async () => {
    const local = makeNamedRepo('notes')
    stubFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        return new Response(JSON.stringify({ message: 'already exists' }), { status: 409 })
      }
      if (url.includes('/api/workspaces')) {
        return new Response(JSON.stringify([
          { id: 'ws-github-decoy', slug: 'gh/other/notes', name: 'notes',
            repoUrl: 'https://github.com/other/notes', syncMode: 'client' },
          { id: 'ws-local-real', slug: 'local/u/notes', name: 'notes',
            repoUrl: null, syncMode: 'client' },
        ]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })

    await handleSync(cfg(false), { dir: local }).catch(() => { /* later steps may fail */ })

    const cfgPath = path.join(local, '.margins.json')
    const written = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      : null
    expect(
      written?.['workspace_id'],
      'narrowing must not break the legitimate local resume',
    ).toBe('ws-local-real')
    fs.rmSync(path.dirname(local), { recursive: true, force: true })
  })

  // ─── Over-refusal controls ────────────────────────────────────────────────
  // Without these, "throw on every error" satisfies all three tests above.

  it('a 409 with NO code keeps today\'s find-then-fallback behaviour', async () => {
    // An older server, or a proxy that dropped the body shape. Treating a codeless
    // 409 as a refusal would send users to ask for an invite they do not need.
    const { bodies } = stubFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (body['source'] === 'github') {
          return new Response(JSON.stringify({ message: 'already exists' }), { status: 409 })
        }
        return new Response(JSON.stringify({ workspace: { id: 'ws-local', slug: 'local/u/docs' } }), { status: 200 })
      }
      if (url.includes('/api/workspaces')) return new Response('[]', { status: 200 })
      return new Response('{}', { status: 200 })
    })

    await handleSync(cfg(false), { dir }).catch(() => { /* later steps may fail; the create is what matters */ })

    expect(
      localCreates(bodies).length,
      'a codeless 409 must still fall back, exactly as before',
    ).toBeGreaterThan(0)
  })

  it('a NON-conflict failure keeps today\'s local fallback', async () => {
    const { bodies } = stubFetch((url, init) => {
      if (init?.method === 'POST' && url.endsWith('/api/workspaces')) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (body['source'] === 'github') {
          return new Response(JSON.stringify({ error: 'GITHUB_NOT_LINKED', message: 'not linked' }), { status: 422 })
        }
        return new Response(JSON.stringify({ workspace: { id: 'ws-local', slug: 'local/u/docs' } }), { status: 200 })
      }
      if (url.includes('/api/workspaces')) return new Response('[]', { status: 200 })
      return new Response('{}', { status: 200 })
    })

    await handleSync(cfg(false), { dir }).catch(() => { /* as above */ })

    expect(
      localCreates(bodies).length,
      'GITHUB_NOT_LINKED must still produce a local workspace',
    ).toBeGreaterThan(0)
  })
})
