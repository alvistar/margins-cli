/**
 * `currentGitBranch` — one branch-detection helper, against real git.
 *
 * There used to be two, in `push.ts` and `content-mode.ts`, and they had
 * DRIFTED: the newer one appended `|| 'main'` and the older one did not. They
 * are consolidated here, and this file pins the fallback that survived, because
 * a silent divergence between two copies of the same question is exactly how
 * one caller ends up pushing to a branch named "".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { currentGitBranch } from '../src/lib/git-branch.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-branch-'))
})

afterEach(() => {
  vi.resetModules()
  fs.rmSync(dir, { recursive: true, force: true })
})

function git(args: string[], cwd = dir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(): void {
  git(['init', '-q', '-b', 'main', '.'])
  git(['config', 'user.email', 'test@margins.test'])
  git(['config', 'user.name', 'Margins Test'])
  // Neutralise whatever the ambient global gitconfig says: a developer with
  // `commit.gpgsign=true` globally would otherwise block on a signing key that
  // does not exist in a temp repo, and `core.autocrlf` varies per machine.
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'commit.gpgsign', 'false'])
}

function commit(): string {
  fs.writeFileSync(path.join(dir, 'a.md'), '# a\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'c'])
  return git(['rev-parse', 'HEAD']).trim()
}

describe('currentGitBranch — against real git', () => {
  it('reports the branch actually checked out', () => {
    initRepo()
    commit()
    expect(currentGitBranch(dir)).toBe('main')

    git(['checkout', '-q', '-b', 'feat/some-work'])
    expect(currentGitBranch(dir)).toBe('feat/some-work')
  })

  it('falls back to main outside any git repository', () => {
    // No `git init` at all.
    expect(currentGitBranch(dir)).toBe('main')
  })

  it('falls back to main in a repository with no commits', () => {
    // `rev-parse --abbrev-ref HEAD` is a hard error here ("ambiguous argument
    // 'HEAD'"), which is why the helper's stderr is discarded — it must not
    // leak past the catch into the user's terminal.
    initRepo()
    expect(currentGitBranch(dir)).toBe('main')
  })

  it('reports HEAD on a detached checkout rather than an empty string', () => {
    initRepo()
    const sha = commit()
    git(['checkout', '-q', sha])
    // Detached HEAD is a SUCCESSFUL call with a real answer — the caller decides
    // what to do about it (handlePush takes an explicit --branch for exactly
    // this case). The helper must not quietly rewrite it to "main".
    expect(currentGitBranch(dir)).toBe('HEAD')
  })
})

describe('currentGitBranch — an empty answer is not a branch name', () => {
  it('falls back to main when git succeeds but prints nothing', async () => {
    // The drift that made consolidation worth doing: one copy returned this
    // empty string verbatim, which would push to a branch literally named "".
    // Unreachable through real git today, which is precisely why it needs
    // pinning — nothing else would catch a regression here.
    vi.resetModules()
    vi.doMock('node:child_process', () => ({ execFileSync: () => '  \n' }))
    const { currentGitBranch: fresh } = await import('../src/lib/git-branch.js')
    expect(fresh(dir)).toBe('main')
    vi.doUnmock('node:child_process')
  })
})
