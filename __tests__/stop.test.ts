import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { stopDaemon } from '../src/lib/runtime.js'
import { handleStop } from '../src/commands/stop.js'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-stop-'))
  process.env['MARGINS_HOME'] = home
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  delete process.env['MARGINS_HOME']
  vi.restoreAllMocks()
})

const daemonFile = () => path.join(home, 'daemon.json')
function writeDaemon(fields: Record<string, unknown>) {
  fs.writeFileSync(
    daemonFile(),
    JSON.stringify({ marker: 'margins-daemon', port: 3000, token: 'x', ...fields }),
  )
}

describe('stopDaemon (margins stop)', () => {
  it('not-running when there is no daemon file', () => {
    expect(stopDaemon()).toEqual({ stopped: false, reason: 'not-running' })
  })

  it('not-running when the marker is not ours — leaves the foreign file alone', () => {
    writeDaemon({ marker: 'some-other-daemon', pid: process.pid })
    expect(stopDaemon()).toEqual({ stopped: false, reason: 'not-running' })
    expect(fs.existsSync(daemonFile())).toBe(true)
  })

  it('stale: a dead PID cleans the discovery file and signals nothing', () => {
    writeDaemon({ pid: 999999999 }) // no such process → ESRCH on the liveness probe
    expect(stopDaemon()).toEqual({ stopped: false, reason: 'stale' })
    expect(fs.existsSync(daemonFile())).toBe(false)
  })

  it('stopped: SIGTERMs a live daemon PID and removes the discovery file', () => {
    // probe(sig 0) → alive; SIGTERM → swallowed (never actually kill anything in a test)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    writeDaemon({ pid: 4242 })
    const result = stopDaemon()
    expect(result).toEqual({ stopped: true, pid: 4242, reason: 'stopped' })
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(fs.existsSync(daemonFile())).toBe(false)
  })
})

describe('handleStop output', () => {
  it('reports no daemon', () => {
    expect(handleStop(false)).toBe('No running Margins Light daemon.')
  })

  it('reports the stopped pid', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    writeDaemon({ pid: 4242 })
    expect(handleStop(false)).toBe('Stopped the Margins Light daemon (pid 4242).')
  })

  it('json returns the structured result', () => {
    writeDaemon({ pid: 999999999 })
    expect(JSON.parse(handleStop(true))).toEqual({ stopped: false, reason: 'stale' })
  })
})
