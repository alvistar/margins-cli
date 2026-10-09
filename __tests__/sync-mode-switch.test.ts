/**
 * `lib/sync-mode-switch.ts` branches the command-level tests do not reach:
 * the best-effort status read, every access-line variant, a cancelled prompt,
 * a bare switch response, and the error mapping's fallbacks and pass-throughs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }))
vi.mock('@clack/prompts', () => ({
  confirm: mockConfirm,
  isCancel: (v: unknown) => v === Symbol.for('clack:cancel'),
}))

import {
  acceptSwitch, fetchSyncStatus, mapSwitchError, switchConsequences, switchToPush,
  type SyncStatus,
} from '../src/lib/sync-mode-switch.js'
import type { ApiClient } from '../src/lib/api-client.js'
import {
  ConflictError, ForbiddenError, NetworkError, ServerError, ValidationError,
} from '../src/lib/errors.js'

const getter = (impl: () => Promise<unknown>): ApiClient =>
  ({ get: vi.fn(impl) }) as unknown as ApiClient
const poster = (impl: () => Promise<unknown>): ApiClient =>
  ({ post: vi.fn(impl) }) as unknown as ApiClient

const status = (credential: SyncStatus['credential']): SyncStatus => ({
  syncMode: 'pull', repository: 'acme/docs', credential, canManagePolicy: true,
})

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  setTTY(false)
})

describe('fetchSyncStatus', () => {
  it('a non-403 failure is best effort: null, no throw', async () => {
    expect(await fetchSyncStatus(getter(async () => { throw new NetworkError('x') }), 'ws-1')).toBeNull()
    expect(await fetchSyncStatus(getter(async () => { throw new ServerError(500) }), 'ws-1')).toBeNull()
  })

  it('a 403 is the creator-only refusal, before any prompt', async () => {
    await expect(fetchSyncStatus(getter(async () => { throw new ForbiddenError('p', 'INSUFFICIENT_ROLE') }), 'ws-1'))
      .rejects.toThrow(/Only the workspace creator/)
  })

  it('translates the API value: server is pull, client is push', async () => {
    const credential = { source: 'none', installationAccount: null, holder: null }
    expect((await fetchSyncStatus(getter(async () => ({ syncMode: 'server', repository: 'a/b', credential, canManagePolicy: true })), 'ws-1'))?.syncMode)
      .toBe('pull')
    expect((await fetchSyncStatus(getter(async () => ({ syncMode: 'client', repository: 'a/b', credential, canManagePolicy: true })), 'ws-1'))?.syncMode)
      .toBe('push')
  })

  it('an unexpected shape is null (unknown mode, no credential, null body)', async () => {
    expect(await fetchSyncStatus(getter(async () => null), 'ws-1')).toBeNull()
    expect(await fetchSyncStatus(getter(async () => ({ syncMode: 'sideways', credential: {} })), 'ws-1')).toBeNull()
    expect(await fetchSyncStatus(getter(async () => ({ syncMode: 'server' })), 'ws-1')).toBeNull()
  })

  it('canManagePolicy:false refuses with the creator-only message', async () => {
    const c = getter(async () => ({ ...status({ source: 'none', installationAccount: null, holder: null }), syncMode: 'server', canManagePolicy: false }))
    await expect(fetchSyncStatus(c, 'ws-1')).rejects.toBeInstanceOf(ValidationError)
    await expect(fetchSyncStatus(c, 'ws-1')).rejects.toThrow(/Only the workspace creator/)
  })

  it('a well-formed status is returned, translated', async () => {
    const s = status({ source: 'none', installationAccount: null, holder: null })
    // The server answers its API value; the CLI holds the word.
    expect(await fetchSyncStatus(getter(async () => ({ ...s, syncMode: 'server' })), 'ws-1')).toEqual(s)
  })
})

describe('switchConsequences — the access line', () => {
  const access = (lines: string[]) => lines.filter((l) => l.includes('GitHub access'))

  it('an unknown status still says access is removed, generically', () => {
    expect(access(switchConsequences('acme/docs', null, 'anything')))
      .toEqual(['  - The GitHub access Margins uses for this workspace is removed from it.'])
  })

  it('a holder with no name falls back to the GitHub login, then to "a member"', () => {
    expect(access(switchConsequences('acme/docs',
      status({ source: 'oauth', installationAccount: null, holder: { id: 'u', name: null, githubLogin: 'ada' } }), 'anything')))
      .toEqual(["  - The GitHub access it uses, ada's account, is removed from this workspace."])
    expect(access(switchConsequences('acme/docs',
      status({ source: 'oauth', installationAccount: null, holder: { id: 'u', name: null, githubLogin: null } }), 'anything')))
      .toEqual(["  - The GitHub access it uses, a member's account, is removed from this workspace."])
  })

  it('no access at all (source none, no holder): the line is omitted', () => {
    const lines = switchConsequences('acme/docs', status({ source: 'none', installationAccount: null, holder: null }), 'anything')
    expect(access(lines)).toEqual([])
    expect(lines).toContain('  - Content stays as it is until the first push.')
  })

  it('an installation with no account name falls through to the holder', () => {
    expect(access(switchConsequences('acme/docs',
      status({ source: 'installation', installationAccount: null, holder: { id: 'u', name: 'Ada', githubLogin: null } }), 'anything')))
      .toEqual(["  - The GitHub access it uses, Ada's account, is removed from this workspace."])
  })
})

describe('acceptSwitch', () => {
  it('a cancelled prompt (Ctrl-C) is cancelled — neither accepted nor a per-repo decline', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(Symbol.for('clack:cancel'))
    expect(await acceptSwitch({})).toBe('cancelled')
  })

  it('--yes wins over --json; --json alone never prompts', async () => {
    setTTY(true)
    expect(await acceptSwitch({ yes: true, json: true })).toBe('accepted')
    expect(await acceptSwitch({ json: true })).toBe('not-interactive')
    expect(mockConfirm).not.toHaveBeenCalled()
  })
})

describe('switchToPush', () => {
  it('a bare or empty response is switched:false with no extra keys', async () => {
    expect(await switchToPush(poster(async () => null), 'ws-1')).toEqual({ syncMode: 'push', switched: false })
    expect(await switchToPush(poster(async () => ({})), 'ws-1')).toEqual({ syncMode: 'push', switched: false })
  })

  it('carries repairedBranches (Margins 0.77.1) when the server sends it', async () => {
    expect(await switchToPush(poster(async () => ({ syncMode: 'client', switched: false, repairedBranches: ['main'] })), 'ws-1'))
      .toEqual({ syncMode: 'push', switched: false, repairedBranches: ['main'] })
  })

  it('posts the API value to the sync-mode route', async () => {
    const c = poster(async () => ({ switched: true }))
    await switchToPush(c, 'ws-9')
    expect(c.post).toHaveBeenCalledWith('/api/workspaces/ws-9/sync-mode', { syncMode: 'client' })
  })

  it('a refusal is thrown mapped', async () => {
    await expect(switchToPush(poster(async () => { throw new ServerError(500, 'UPDATE_FAILED') }), 'ws-1'))
      .rejects.toThrow(/Failed to switch to push\. Nothing was changed/)
  })
})

describe('mapSwitchError — fallbacks and pass-throughs', () => {
  it('500 UPDATE_FAILED: server wording wins, else our fallback', () => {
    expect(mapSwitchError(new ServerError(500, 'UPDATE_FAILED', 'DB said no.')).message).toMatch(/DB said no\.$/)
    expect(mapSwitchError(new ServerError(500, 'UPDATE_FAILED')).message)
      .toMatch(/Failed to switch to push\. Nothing was changed\.$/)
  })

  it('422 BLOCKED with no server message still says nothing changed', () => {
    expect(mapSwitchError(new ServerError(422, 'SYNC_MODE_SWITCH_BLOCKED')).message)
      .toMatch(/Nothing was changed/)
  })

  it('anything unrecognised is passed through untouched', () => {
    const other409 = new ConflictError('x', 'SOMETHING_ELSE')
    const other422 = new ServerError(422, 'VALIDATION_FAILED')
    const plain500 = new ServerError(500)
    const net = new NetworkError('https://margins.test')
    const raw = new Error('boom')
    for (const e of [other409, other422, plain500, net, raw]) expect(mapSwitchError(e)).toBe(e)
  })
})
