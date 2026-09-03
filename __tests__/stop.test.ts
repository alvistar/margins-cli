/**
 * `margins stop` DELEGATES to the runtime's launcher (runtime 0.15.0+).
 *
 * It used to read `~/.margins/daemon.json` and SIGTERM the pid itself. That file is gone —
 * each store now publishes `~/.margins/daemons/<storeKey>.json` — so a CLI carrying its own
 * copy of the discovery format reported "no running daemon" about a daemon that was running
 * and left it holding `.margins.lock`.
 *
 * These tests therefore assert the DELEGATION, not a file format: that a launcher is invoked
 * with `stop --json`, that its verdict is translated faithfully, and that a missing runtime
 * is "not-running" rather than a crash or a download. The format itself is the runtime's
 * business, which is the whole point of delegating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const spawnSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawnSync,
}))

const { stopDaemon } = await import('../src/lib/runtime.js')
const { handleStop } = await import('../src/commands/stop.js')

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-stop-'))
  process.env['MARGINS_HOME'] = home
  spawnSync.mockReset()
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  delete process.env['MARGINS_HOME']
  vi.restoreAllMocks()
})

/** A cached runtime, complete enough for listRuntimes() and the launcher path to resolve. */
function installRuntime(version: string) {
  const pkg = path.join(home, 'runtime', version, 'node_modules', '@alvistar', 'margins-light')
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'server.js'), '// standalone entry')
  fs.writeFileSync(path.join(pkg, 'scripts', 'launcher.mjs'), '// launcher')
  return path.join(pkg, 'scripts', 'launcher.mjs')
}

const launcherSaid = (line: string) => spawnSync.mockReturnValue({ stdout: line, status: 0 })

describe('stopDaemon delegates to the runtime launcher', () => {
  it('not-running, and spawns NOTHING, when no runtime is cached', () => {
    // No cached runtime means no daemon can be running. It must not download one to ask.
    expect(stopDaemon()).toEqual({ stopped: false, reason: 'not-running' })
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('invokes the newest cached launcher with `stop --json`', () => {
    installRuntime('0.14.0')
    const newest = installRuntime('0.15.0')
    launcherSaid('{"outcome":"stopped","running":true,"pid":4242,"port":49957,"forced":false}')
    stopDaemon()
    expect(spawnSync).toHaveBeenCalledTimes(1)
    const [, argv] = spawnSync.mock.calls[0]!
    expect(argv).toEqual([newest, 'stop', '--json'])
  })

  it('translates a stopped verdict, carrying the pid the launcher reported', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"stopped","running":true,"pid":4242,"port":49957,"forced":false}')
    expect(stopDaemon()).toEqual({ stopped: true, pid: 4242, reason: 'stopped' })
  })

  it('translates not-running', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"not-running","running":false,"pid":null,"port":null,"forced":false}')
    expect(stopDaemon()).toEqual({ stopped: false, reason: 'not-running' })
  })

  it('does NOT report a refused stop as not-running — the daemon is still there', () => {
    // `refused` means the launcher found a daemon and deliberately would not signal it (a
    // wedged one, or a lock it could not identify). Reporting "no running daemon" would tell
    // the user the opposite of the truth and send them hunting.
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"refused","running":true,"pid":4242,"port":49957,"forced":false}')
    expect(stopDaemon()).toEqual({ stopped: false, pid: 4242, reason: 'stale' })
  })

  it('does NOT report a timed-out stop as stopped — it was signalled but is still alive', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"timed-out","running":true,"pid":4242,"port":49957,"forced":false}')
    expect(stopDaemon()).toEqual({ stopped: false, pid: 4242, reason: 'stale' })
  })

  it.each([
    ['empty stdout', ''],
    ['unparseable stdout', 'Error: something went wrong'],
  ])('survives %s from the launcher without throwing', (_label, stdout) => {
    installRuntime('0.15.0')
    launcherSaid(stdout)
    expect(stopDaemon()).toEqual({ stopped: false, reason: 'not-running' })
  })

  it('reads the LAST line, so launcher warnings before the JSON do not break it', () => {
    installRuntime('0.15.0')
    launcherSaid('warning: something\n{"outcome":"stopped","running":true,"pid":7,"port":1,"forced":false}')
    expect(stopDaemon()).toEqual({ stopped: true, pid: 7, reason: 'stopped' })
  })
})

describe('handleStop output', () => {
  it('reports no daemon', () => {
    expect(handleStop(false)).toBe('No running Margins Light daemon.')
  })

  it('reports the stopped pid', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"stopped","running":true,"pid":4242,"port":49957,"forced":false}')
    expect(handleStop(false)).toBe('Stopped the Margins Light daemon (pid 4242).')
  })

  it('json returns the structured result', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"refused","running":true,"pid":4242,"port":1,"forced":false}')
    expect(JSON.parse(handleStop(true))).toEqual({ stopped: false, pid: 4242, reason: 'stale' })
  })
})
