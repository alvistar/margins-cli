import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Mock the thin npm/gh exec wrappers — runtime.ts is pure logic on top (like the gh.ts tests).
const mocks = vi.hoisted(() => ({
  npmInstall: vi.fn(),
  npmViewVersion: vi.fn(),
  ghAuthToken: vi.fn(),
}))
vi.mock('../src/lib/npm.js', () => ({
  npmInstall: mocks.npmInstall,
  npmViewVersion: mocks.npmViewVersion,
  ghAuthToken: mocks.ghAuthToken,
  // Defined INSIDE the factory (hoisted) so runtime.ts + the test share the same mocked class.
  NpmExecError: class NpmExecError extends Error {
    stderr: string
    constructor(message: string, stderr: string) {
      super(message)
      this.stderr = stderr
      this.name = 'NpmExecError'
    }
  },
}))

import {
  ensureRuntime,
  resolveRuntimeToken,
  assertNode,
  pkgRootFor,
  listRuntimes,
} from '../src/lib/runtime.js'
import { NpmExecError } from '../src/lib/npm.js'
import {
  RuntimeAuthError,
  RuntimeNotPublishedError,
  NodeTooOldError,
  RuntimeInstallError,
} from '../src/lib/errors.js'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-home-'))
  process.env['MARGINS_HOME'] = home
  process.env['MARGINS_RUNTIME_TOKEN'] = 'tok-classic-pat'
  delete process.env['GITHUB_TOKEN']
  mocks.npmInstall.mockReset()
  mocks.npmViewVersion.mockReset()
  mocks.ghAuthToken.mockReset().mockResolvedValue(null)
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  delete process.env['MARGINS_HOME']
  delete process.env['MARGINS_RUNTIME_TOKEN']
})

/** A realistic install: land @alvistar/margins-light/server.js in cwd/node_modules. */
function fakeInstall(cwd: string) {
  const pkg = path.join(cwd, 'node_modules', '@alvistar', 'margins-light')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'server.js'), '// runtime')
}

describe('ensureRuntime — resolve → install → cache (U5)', () => {
  it('cache miss: writes an isolated .npmrc, installs, atomically promotes → returns pkgRoot', async () => {
    mocks.npmViewVersion.mockResolvedValue('0.1.0')
    let npmrcSeen = ''
    mocks.npmInstall.mockImplementation(async (_spec: string, cwd: string, userconfig: string) => {
      npmrcSeen = fs.readFileSync(userconfig, 'utf8')
      fakeInstall(cwd)
    })
    const { version, pkgRoot } = await ensureRuntime()
    expect(version).toBe('0.1.0')
    expect(pkgRoot).toBe(pkgRootFor('0.1.0'))
    expect(fs.existsSync(path.join(pkgRoot, 'server.js'))).toBe(true)
    // Codex #9: PUBLIC registry for unscoped deps + scoped GitHub Packages for @alvistar only
    expect(npmrcSeen).toContain('registry=https://registry.npmjs.org/')
    expect(npmrcSeen).toContain('@alvistar:registry=https://npm.pkg.github.com')
    expect(npmrcSeen).toContain('_authToken=tok-classic-pat')
  })

  it('cache hit: returns the cached path, NO install', async () => {
    mocks.npmInstall.mockImplementation(async (_s: string, cwd: string) => fakeInstall(cwd))
    await ensureRuntime({ version: '0.1.0' })
    mocks.npmInstall.mockClear()
    const { pkgRoot } = await ensureRuntime({ version: '0.1.0' })
    expect(pkgRoot).toBe(pkgRootFor('0.1.0'))
    expect(mocks.npmInstall).not.toHaveBeenCalled()
  })

  it('failed install → RuntimeInstallError + NO partial runtime cached (atomic)', async () => {
    mocks.npmInstall.mockRejectedValue(new NpmExecError('boom', 'network error ETIMEDOUT'))
    await expect(ensureRuntime({ version: '0.1.0' })).rejects.toBeInstanceOf(RuntimeInstallError)
    expect(fs.existsSync(pkgRootFor('0.1.0'))).toBe(false)
    expect(listRuntimes()).toEqual([])
  })

  it('401/403 → RuntimeAuthError; 404 → RuntimeNotPublishedError', async () => {
    mocks.npmInstall.mockRejectedValueOnce(new NpmExecError('x', 'npm error code E401 Unauthorized'))
    await expect(ensureRuntime({ version: '0.1.0' })).rejects.toBeInstanceOf(RuntimeAuthError)
    mocks.npmInstall.mockRejectedValueOnce(new NpmExecError('x', 'npm error 404 Not Found - GET'))
    await expect(ensureRuntime({ version: '0.1.0' })).rejects.toBeInstanceOf(RuntimeNotPublishedError)
  })

  it('concurrent ensureRuntime for the same version → ONE install, both get the path', async () => {
    mocks.npmViewVersion.mockResolvedValue('0.1.0')
    mocks.npmInstall.mockImplementation(async (_s: string, cwd: string) => {
      await new Promise((r) => setTimeout(r, 50))
      fakeInstall(cwd)
    })
    const [a, b] = await Promise.all([ensureRuntime(), ensureRuntime()])
    expect(a.pkgRoot).toBe(b.pkgRoot)
    expect(mocks.npmInstall).toHaveBeenCalledTimes(1)
  })

  it('no token → RuntimeAuthError before any install', async () => {
    delete process.env['MARGINS_RUNTIME_TOKEN']
    mocks.ghAuthToken.mockResolvedValue(null)
    await expect(ensureRuntime({ version: '0.1.0' })).rejects.toBeInstanceOf(RuntimeAuthError)
    expect(mocks.npmInstall).not.toHaveBeenCalled()
  })

  it('the token .npmrc is NEVER persisted in the runtime cache (Security F1)', async () => {
    mocks.npmInstall.mockImplementation(async (_s: string, cwd: string, userconfig: string) => {
      // present in the ephemeral userconfig during the install…
      expect(fs.readFileSync(userconfig, 'utf8')).toContain('_authToken=tok-classic-pat')
      fakeInstall(cwd)
    })
    await ensureRuntime({ version: '0.1.0' })
    // …but nothing token-bearing is renamed into the cached version dir
    expect(fs.existsSync(path.join(home, 'runtime', '0.1.0', '.npmrc'))).toBe(false)
  })

  it('a stale lock from a dead/crashed install is reclaimed, not wedged (H1/M1)', async () => {
    fs.mkdirSync(path.join(home, 'runtime'), { recursive: true })
    const lock = path.join(home, 'runtime', '.lock-0.1.0')
    fs.writeFileSync(lock, '999999') // a holder PID that no longer exists
    const old = new Date(Date.now() - 60 * 60_000) // 1h ago → older than the staleness ceiling
    fs.utimesSync(lock, old, old)
    mocks.npmInstall.mockImplementation(async (_s: string, cwd: string) => fakeInstall(cwd))
    const { pkgRoot } = await ensureRuntime({ version: '0.1.0' })
    expect(fs.existsSync(path.join(pkgRoot, 'server.js'))).toBe(true)
    expect(mocks.npmInstall).toHaveBeenCalledTimes(1) // installed, did not spin 60s and throw
    expect(fs.existsSync(lock)).toBe(false) // reclaimed
  })
})

describe('offline / registry-down fallback', () => {
  it('falls back to the newest cached runtime on a network failure', async () => {
    mocks.npmInstall.mockImplementation(async (_s: string, cwd: string) => fakeInstall(cwd))
    await ensureRuntime({ version: '0.1.0' }) // seed a cache
    mocks.npmViewVersion.mockRejectedValue(new NpmExecError('boom', 'network error ETIMEDOUT'))
    const { version } = await ensureRuntime()
    expect(version).toBe('0.1.0')
  })

  it('does NOT silently fall back on an auth failure — surfaces it (Correctness P3)', async () => {
    mocks.npmInstall.mockImplementation(async (_s: string, cwd: string) => fakeInstall(cwd))
    await ensureRuntime({ version: '0.1.0' }) // a cache exists…
    mocks.npmViewVersion.mockRejectedValue(new NpmExecError('x', 'npm error code E401 Unauthorized'))
    await expect(ensureRuntime()).rejects.toBeInstanceOf(RuntimeAuthError) // …but auth still surfaces
  })
})

describe('token + node gates', () => {
  it('resolveRuntimeToken: explicit env wins, else gh', async () => {
    mocks.ghAuthToken.mockResolvedValue('gh-tok')
    expect(await resolveRuntimeToken({ MARGINS_RUNTIME_TOKEN: 'x' })).toBe('x')
    expect(await resolveRuntimeToken({ GITHUB_TOKEN: 'y' })).toBe('y')
    expect(await resolveRuntimeToken({})).toBe('gh-tok')
  })
  it('assertNode throws below the minimum', () => {
    expect(() => assertNode('v18.19.0')).toThrow(NodeTooOldError)
    expect(() => assertNode('v20.0.0')).not.toThrow()
  })
})
