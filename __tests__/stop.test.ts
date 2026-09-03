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

/**
 * A launcher that answers `line`.
 *
 * It honours `encoding` the way the real `spawnSync` does — string only when asked, Buffer
 * otherwise. The first version returned a string unconditionally, so deleting
 * `encoding: 'utf8'` from the production call left every test green while a real run threw
 * `res.stdout.trim is not a function`. A mock that is easier to satisfy than reality tests
 * nothing.
 */
const launcherSaid = (line: string) =>
  spawnSync.mockImplementation((_cmd: string, _argv: string[], opts?: { encoding?: string }) => ({
    status: 0,
    signal: null,
    stdout: opts?.encoding === 'utf8' ? line : Buffer.from(line),
    stderr: opts?.encoding === 'utf8' ? '' : Buffer.from(''),
  }))

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
    // The options matter as much as the argv and were previously unasserted: `encoding`
    // keeps stdout a string, and `timeout` is the only thing stopping a wedged launcher
    // from hanging `margins stop` forever. Deleting either left the suite green.
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [newest, 'stop', '--json'],
      expect.objectContaining({ encoding: 'utf8', timeout: 30_000 }),
    )
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

  it('keeps refused distinct — the launcher found a daemon and would not signal it', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"refused","running":true,"pid":4242,"port":49957,"forced":false}')
    expect(stopDaemon()).toEqual({ stopped: false, pid: 4242, reason: 'refused' })
  })

  it('keeps timed-out distinct — signalled, and still alive', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"timed-out","running":true,"pid":4242,"port":49957,"forced":false}')
    expect(stopDaemon()).toEqual({ stopped: false, pid: 4242, reason: 'timed-out' })
  })

  // These two used to assert `reason: 'not-running'` — writing the exact lie this release
  // exists to remove into the suite as if it were the contract. A launcher that cannot
  // answer has told us nothing about whether a daemon is running.
  it.each([
    ['empty stdout', ''],
    ['unparseable stdout', 'Error: something went wrong'],
  ])('reports %s as a FAILURE, never as "no daemon running"', (_label, stdout) => {
    installRuntime('0.15.0')
    launcherSaid(stdout)
    const r = stopDaemon()
    expect(r.reason).toBe('failed')
    expect(r.stopped).toBe(false)
    expect(r.detail).toBeTruthy()
  })

  // Each case asserts the DETAIL, not just `reason: 'failed'`. Asserting the reason alone
  // does not pin which branch produced it: a spawn error also has `status: null`, so the
  // non-zero-exit branch catches it too, and deleting the `res.error` check left the suite
  // green. The message is what proves the right branch ran — and it is what the user reads.
  it.each([
    ['a non-zero exit', { status: 1, signal: null, stdout: '', stderr: 'boom' }, /exited 1: boom/],
    [
      'a spawn failure',
      { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), status: null, signal: null, stdout: null },
      /could not run the runtime launcher.*ENOENT/,
    ],
    ['our own 30s timeout killing it', { status: null, signal: 'SIGTERM', stdout: '' }, /killed by SIGTERM/],
  ])('reports %s as a FAILURE naming the cause', (_label, res, expected) => {
    // The worst outcomes of a process-lifecycle command must not render as its most
    // reassuring sentence while the daemon stays alive holding `.margins.lock`.
    installRuntime('0.15.0')
    spawnSync.mockReturnValue(res)
    const r = stopDaemon()
    expect(r.reason).toBe('failed')
    expect(r.detail).toMatch(expected)
  })

  it('treats a stop claim with no pid as malformed, not as success', () => {
    // It printed "Stopped the Margins Light daemon (pid undefined)."
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"stopped"}')
    expect(stopDaemon().reason).toBe('failed')
  })

  it('a cached runtime with NO launcher is not-running, and spawns nothing', () => {
    const pkg = path.join(home, 'runtime', '0.9.0', 'node_modules', '@alvistar', 'margins-light')
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'server.js'), '// an old runtime, no launcher')
    expect(stopDaemon()).toEqual({ stopped: false, reason: 'not-running' })
    expect(spawnSync).not.toHaveBeenCalled()
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
    expect(JSON.parse(handleStop(true))).toEqual({ stopped: false, pid: 4242, reason: 'refused' })
  })

  // The PROSE path had no test at all: the only refused case went through `formatJson`,
  // which bypasses the message switch. So the suite asserted the principle in JSON while
  // the sentence a human reads said the opposite.
  it('the refused message says the daemon is STILL RUNNING and names it', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"refused","running":true,"pid":4242,"port":1,"forced":false}')
    const out = handleStop(false)
    expect(out).not.toMatch(/No running Margins Light daemon/)
    expect(out).not.toMatch(/cleaned up/)
    expect(out).toMatch(/still running/)
    expect(out).toMatch(/4242/)
  })

  it('the timed-out message does not claim success', () => {
    installRuntime('0.15.0')
    launcherSaid('{"outcome":"timed-out","running":true,"pid":4242,"port":1,"forced":false}')
    const out = handleStop(false)
    expect(out).not.toMatch(/^Stopped/)
    expect(out).toMatch(/still running/)
  })

  it('a launcher failure is reported with its reason, not as an absence', () => {
    installRuntime('0.15.0')
    spawnSync.mockReturnValue({ status: 1, signal: null, stdout: '', stderr: 'boom' })
    const out = handleStop(false)
    expect(out).not.toMatch(/No running Margins Light daemon/)
    expect(out).toMatch(/boom/)
  })
})
