import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the git-remote boundary so results never depend on the test runner's
// real `origin` (mirrors the gh.js boundary mock used across the command tests).
const { mockDetect } = vi.hoisted(() => ({ mockDetect: vi.fn() }))

vi.mock('../src/lib/detect-git-remote.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/detect-git-remote.js')>(
    '../src/lib/detect-git-remote.js',
  )
  return { ...actual, detectGitRemote: mockDetect }
})

vi.mock('../src/lib/gh.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/gh.js')>('../src/lib/gh.js')
  return { ...actual, listOrgRepos: vi.fn() }
})

import * as gh from '../src/lib/gh.js'
import { resolveRepoTargets } from '../src/lib/repo-targets.js'

const mockedGh = vi.mocked(gh)

beforeEach(() => {
  vi.clearAllMocks()
  mockDetect.mockReturnValue({ type: 'none' })
})

describe('resolveRepoTargets', () => {
  it('explicit target → normalized target, no auto-detect', async () => {
    const res = await resolveRepoTargets('acme/docs', {})
    expect(res).toEqual({ targets: ['acme/docs'], autoDetected: null })
    expect(mockDetect).not.toHaveBeenCalled()
  })

  it('--org → filtered listing, no auto-detect', async () => {
    mockedGh.listOrgRepos.mockResolvedValue(['acme/docs', 'acme/infra'])
    const res = await resolveRepoTargets(undefined, { org: 'acme', include: ['*docs*'] })
    expect(res.targets).toEqual(['acme/docs'])
    expect(res.autoDetected).toBeNull()
    expect(mockDetect).not.toHaveBeenCalled()
  })

  it('target + --org → throws (ambiguous), never lists or detects', async () => {
    await expect(resolveRepoTargets('acme/docs', { org: 'acme' }))
      .rejects.toThrow('Specify a repo OR --org, not both')
    expect(mockedGh.listOrgRepos).not.toHaveBeenCalled()
    expect(mockDetect).not.toHaveBeenCalled()
  })

  it('no target/org, GitHub origin → resolves owner/repo + autoDetected', async () => {
    mockDetect.mockReturnValue({ type: 'github', owner: 'acme', repo: 'docs' })
    const res = await resolveRepoTargets(undefined, {})
    expect(res).toEqual({ targets: ['acme/docs'], autoDetected: { owner: 'acme', repo: 'docs' } })
  })

  it('no target/org, non-GitHub origin → throws GitHub-required, naming the URL', async () => {
    mockDetect.mockReturnValue({ type: 'other', url: 'https://gitlab.com/acme/docs.git' })
    await expect(resolveRepoTargets(undefined, {}))
      .rejects.toThrow(/origin \(https:\/\/gitlab\.com\/acme\/docs\.git\) is not a GitHub repo/)
  })

  it('no target/org, no origin remote → throws the generic specify-a-repo error', async () => {
    mockDetect.mockReturnValue({ type: 'none' })
    await expect(resolveRepoTargets(undefined, {}))
      .rejects.toThrow('Specify a repo (owner/repo or GitHub URL) or --org')
  })
})
