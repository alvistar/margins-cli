/**
 * `margins sync` on a folder whose GitHub workspace does not take pushes
 * (ai-review#282): the refusal names the switch for a workspace that pulls,
 * and never binds an unknown mode as push.
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

function cfg(): ResolvedConfig {
  return { apiKey: 'mrgn_test', serverUrl: 'https://margins.test', json: false } as unknown as ResolvedConfig
}

function stubFetch(syncMode: string): string[] {
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push(`${method} ${new URL(url).pathname}`)
    if (method === 'POST' && url.endsWith('/api/workspaces')) {
      // Codeless 409: reaches the membership lookup, not the SLUG_CONFLICT stop.
      return new Response(JSON.stringify({ message: 'already exists' }), { status: 409 })
    }
    if (url.includes('/api/workspaces')) {
      return new Response(JSON.stringify([{
        id: 'ws-acme-docs', slug: 'gh/acme/docs', name: 'docs',
        repoUrl: 'https://github.com/acme/docs', syncMode,
      }]), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }))
  return writes
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-pullguard-'))
  dir = path.join(root, 'docs')
  fs.mkdirSync(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/docs.git'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# hello\n')
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-pullguard-data-'))
  vi.stubEnv('MARGINS_DATA_DIR', dataDir)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('sync — a GitHub workspace that does not take pushes', () => {
  it('pulls from GitHub: refused, naming the switch command for this repo', async () => {
    const writes = stubFetch('server')

    await expect(handleSync(cfg(), { dir })).rejects.toThrow(
      'Workspace gh/acme/docs pulls from GitHub. Switch it to push first — '
      + '`margins sync-mode push acme/docs` — then sync this folder.',
    )
    expect(fs.existsSync(path.join(dir, '.margins.json'))).toBe(false)
    expect(writes).toEqual(['POST /api/workspaces'])
  })

  it('an unknown mode: refused, never bound as push', async () => {
    stubFetch('sideways')

    await expect(handleSync(cfg(), { dir })).rejects.toThrow(
      /Workspace gh\/acme\/docs reports an unknown sync mode \("sideways"\) — not syncing this folder\./,
    )
    expect(fs.existsSync(path.join(dir, '.margins.json'))).toBe(false)
  })
})
