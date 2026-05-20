import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleInstallHook } from '../src/commands/install-hook.js'

let tmpDir: string
let originalCwd: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-install-hook-'))
  fs.mkdirSync(path.join(tmpDir, '.git'))
  originalCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('handleInstallHook', () => {
  it('generates a pre-push hook that calls `margins workspace push` (not `margins push`)', async () => {
    await handleInstallHook({})
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'), 'utf-8')
    // The CLI only registers `margins workspace push`. A bare `margins push` errors
    // with `unknown command 'push'`, silently failing the hook.
    expect(hook).toContain('margins workspace push')
    expect(hook).not.toMatch(/^margins push\b/m)
  })

  it('does not pass a --branch flag (workspace push does not accept it)', async () => {
    await handleInstallHook({})
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'), 'utf-8')
    // workspace push detects branch via `git rev-parse --abbrev-ref HEAD` internally.
    // Passing --branch would trip Commander's "unknown option" error.
    expect(hook).not.toContain('--branch')
  })

  it('generates an executable pre-push hook by default', async () => {
    await handleInstallHook({})
    const stat = fs.statSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'))
    expect(stat.mode & 0o111).not.toBe(0)
  })

  it('runs the sync in the background and exits 0 (non-blocking)', async () => {
    await handleInstallHook({})
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'), 'utf-8')
    expect(hook).toMatch(/&\s*$/m)
    expect(hook).toMatch(/^exit 0$/m)
  })

  it('with --on commit, installs a post-commit hook instead', async () => {
    await handleInstallHook({ on: 'commit' })
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-push'))).toBe(false)
    const hook = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf-8')
    expect(hook).toContain('margins workspace push')
  })
})
