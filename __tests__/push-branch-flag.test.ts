import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ResolvedConfig } from '../src/lib/config.js'

// Unlike the legacy (skipped) handlePush tests, mock casSync directly so we can
// assert the branch argument it receives — that is the whole surface of U6.
const mockCasSync = vi.fn()
// Partial mock: only casSync is replaced. The rest of the module (the preflight
// fetch, the mode resolution) must run for real — since U4 the branch is
// resolved BEFORE the preflight, so a fully-stubbed module would hide that.
vi.mock('../src/lib/cas-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/cas-sync.js')>()),
  casSync: mockCasSync,
}))
vi.mock('../src/lib/api-client.js', () => ({
  createApiClient: () => ({
    get: vi.fn(async () => ({ files: {}, headSha: null })),
  }),
}))
// gitBranch() shells out to `git rev-parse --abbrev-ref HEAD`; stub it so the
// fallback assertion is deterministic (not "whatever branch the repo happens to
// be on") and actually proves the detected value flows to casSync.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => 'detected/branch\n'),
  execFileSync: vi.fn(() => { throw new Error('not a git repo') }),
}))

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    serverUrl: 'https://margins.test',
    token: 'test-token',
    json: false,
    verbose: false,
    ...overrides,
  } as ResolvedConfig
}

describe('handlePush --branch resolution (U6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockCasSync.mockReset()
    mockCasSync.mockResolvedValue({ added: 0, changed: 0, deleted: 0, uploaded: 0, skipped: 0 })
  })

  it('passes an explicit --branch through to casSync, overriding git detection', async () => {
    const { handlePush } = await import('../src/commands/workspace/push.js')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await handlePush(makeConfig(), {
      workspace: 'ws-1',
      dir: `${import.meta.dirname}/fixtures/docs`,
      branch: 'feat/x',
    })
    expect(mockCasSync).toHaveBeenCalledTimes(1)
    expect(mockCasSync.mock.calls[0][1]).toBe('ws-1') // workspaceId
    expect(mockCasSync.mock.calls[0][2]).toBe('feat/x') // branch
  })

  it('falls back to the detected git branch when --branch is omitted', async () => {
    const { handlePush } = await import('../src/commands/workspace/push.js')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await handlePush(makeConfig(), {
      workspace: 'ws-1',
      dir: `${import.meta.dirname}/fixtures/docs`,
    })
    expect(mockCasSync).toHaveBeenCalledTimes(1)
    // The stubbed git detection returned "detected/branch"; assert it flowed through
    // (proves gitBranch's output is used, not a hardcoded fallback).
    expect(mockCasSync.mock.calls[0][2]).toBe('detected/branch')
  })
})
