import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(() => ({
  ensureRuntime: vi.fn(),
  handleHostedOpen: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock('../src/lib/runtime.js', () => ({
  ensureRuntime: mocks.ensureRuntime,
  runtimeSchemaVersion: () => null, // compat gate inert in this unit (covered by runtime-mgmt.test)
  assertRuntimeCompat: () => undefined,
  recordStoreSchemaHead: () => undefined,
  storeDir: () => '/fake/store/dir',
}))
vi.mock('../src/commands/workspace/open.js', () => ({ handleOpen: mocks.handleHostedOpen }))
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}))

import { handleOpen, isLocalTarget } from '../src/commands/open.js'

let dir: string
let pkgRoot: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-open-'))
  pkgRoot = path.join(dir, 'pkg')
  fs.mkdirSync(path.join(pkgRoot, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'scripts', 'launcher.mjs'), '// launcher')
  mocks.ensureRuntime.mockReset().mockResolvedValue({ version: '0.1.0', pkgRoot })
  mocks.handleHostedOpen.mockReset().mockResolvedValue(undefined)
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & { emit: (e: string, ...a: unknown[]) => boolean }
    setImmediate(() => child.emit('exit', 0))
    return child
  })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cfg: any = { json: false }

describe('isLocalTarget (R6)', () => {
  it('path shapes + existing paths are local; slugs are hosted', () => {
    expect(isLocalTarget(undefined)).toBe(true)
    expect(isLocalTarget('.')).toBe(true)
    expect(isLocalTarget('./docs')).toBe(true)
    expect(isLocalTarget('../x')).toBe(true)
    expect(isLocalTarget('/abs/path')).toBe(true)
    expect(isLocalTarget(dir)).toBe(true) // existing absolute path
    expect(isLocalTarget('acme/repo')).toBe(false) // no such local path → hosted slug
    expect(isLocalTarget('some-workspace-slug')).toBe(false)
  })
})

describe('handleOpen — local vs hosted (U6)', () => {
  it('a local folder → ensureRuntime + launcher spawn; hosted open NOT called', async () => {
    const folder = path.join(dir, 'docs')
    fs.mkdirSync(folder)
    await handleOpen(cfg, folder)
    expect(mocks.ensureRuntime).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledOnce()
    const [cmd, args, opts] = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      { stdio?: string; env?: NodeJS.ProcessEnv },
    ]
    expect(cmd).toBe(process.execPath) // the CLI's own interpreter, not a PATH `node` (M3)
    expect(args).toEqual([path.join(pkgRoot, 'scripts', 'launcher.mjs'), 'open', folder])
    expect(opts.stdio).toBe('inherit')
    // The daemon's store must follow MARGINS_HOME: pass the CLI-resolved store as MARGINS_PGLITE
    // (the runtime otherwise hardcodes ~/.margins/store) — and spread the real env, not replace it.
    expect(opts.env?.MARGINS_PGLITE).toBe('/fake/store/dir')
    expect(opts.env?.PATH).toBe(process.env.PATH)
    expect(mocks.handleHostedOpen).not.toHaveBeenCalled()
  })

  it('a single .md file → local', async () => {
    const file = path.join(dir, 'x.md')
    fs.writeFileSync(file, '# x')
    await handleOpen(cfg, file)
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('a hosted slug → hosted open, no runtime touched', async () => {
    await handleOpen(cfg, 'acme/repo')
    expect(mocks.handleHostedOpen).toHaveBeenCalledWith(cfg, 'acme/repo')
    expect(mocks.ensureRuntime).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('a missing explicit local path → clear error, no spawn', async () => {
    await expect(handleOpen(cfg, './does-not-exist-xyz')).rejects.toThrow(/Path not found/)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
