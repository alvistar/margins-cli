import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  listRuntimes,
  pruneRuntimes,
  cleanRuntimes,
  pkgRootFor,
  liveRuntimeVersion,
  runtimeSchemaVersion,
  readStoreSchemaHead,
  recordStoreSchemaHead,
  assertRuntimeCompat,
} from '../src/lib/runtime.js'
import { handleRuntimeList, handleRuntimeWhich, handleRuntimeClean } from '../src/commands/runtime.js'
import { RuntimeIncompatibleError } from '../src/lib/errors.js'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-home-'))
  process.env['MARGINS_HOME'] = home
  delete process.env['MARGINS_PGLITE']
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  delete process.env['MARGINS_HOME']
})

/** Fake a cached runtime: <home>/runtime/<v>/node_modules/@alvistar/margins-light/server.js. */
function fakeRuntime(version: string, schemaCount?: number) {
  const pkg = pkgRootFor(version)
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'server.js'), '// runtime')
  const margins = schemaCount != null ? { schemaVersion: { count: schemaCount, tag: `t${schemaCount}`, when: 1 } } : {}
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@alvistar/margins-light', version, margins }))
}

describe('runtime cache — list / prune / clean (U7)', () => {
  it('listRuntimes: cached versions newest-first with sizes; which = active', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.10.0')
    const rts = listRuntimes()
    expect(rts.map((r) => r.version)).toEqual(['0.10.0', '0.2.0', '0.1.0']) // semver desc, not string
    expect(rts[0]?.sizeBytes).toBeGreaterThan(0)
    expect(handleRuntimeWhich(false)).toBe('0.10.0')
  })

  it('pruneRuntimes keeps the newest N, removes older (auto-prune slice)', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    expect(pruneRuntimes(2)).toEqual(['0.1.0'])
    expect(listRuntimes().map((r) => r.version)).toEqual(['0.3.0', '0.2.0'])
  })

  it('cleanRuntimes keeps only the active; handleRuntimeClean reports it', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    expect(handleRuntimeClean(false)).toMatch(/Removed 1 runtime.*0\.1\.0.*Kept the active 0\.2\.0/)
    expect(listRuntimes().map((r) => r.version)).toEqual(['0.2.0'])
    expect(cleanRuntimes('0.2.0')).toEqual([]) // idempotent — only active left
  })

  it('empty-cache messages', () => {
    expect(handleRuntimeList(false)).toMatch(/No Margins Light runtimes cached/)
    expect(handleRuntimeWhich(false)).toMatch(/No Margins Light runtime cached/)
  })
})

describe('runtime cache — in-use guard (M4)', () => {
  /** Write a daemon discovery file naming the runtime dir `version` booted from. */
  function writeDiscovery(version: string, pid: number) {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, 'daemon.json'),
      JSON.stringify({ marker: 'margins-daemon', pid, port: 3000, token: 'x', runtimeDir: pkgRootFor(version) }),
    )
  }

  it('pruneRuntimes NEVER deletes the version a LIVE daemon is serving from', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    writeDiscovery('0.1.0', process.pid) // an old daemon is live on 0.1.0
    expect(pruneRuntimes(2)).toEqual([]) // 0.1.0 would be pruned, but it's in use → skipped
    expect(fs.existsSync(pkgRootFor('0.1.0'))).toBe(true)
  })

  it('pruneRuntimes prunes normally when the daemon PID is dead (recovery)', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    writeDiscovery('0.1.0', 999999) // discovery names a holder that no longer exists
    expect(pruneRuntimes(2)).toEqual(['0.1.0']) // dead daemon → not in use → prune proceeds
  })

  /** A per-store rendezvous record (runtime 0.15.0+). The filename is a store hash the CLI
   *  never computes — the scan is deliberately filename-agnostic. */
  function writeStoreRecord(name: string, version: string, pid: number) {
    const dir = path.join(home, 'daemons')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({
        v: 1,
        marker: 'margins-daemon',
        store: `/store/${name}`,
        pid,
        port: 40000,
        token: 'x',
        ready: true,
        runtimeDir: pkgRootFor(version),
      }),
    )
  }

  it('pruneRuntimes NEVER deletes a version a live daemon is serving from — PER-STORE record', () => {
    // Runtime 0.15.0 stopped writing ~/.margins/daemon.json. Reading only that file makes
    // this guard silently answer "nothing is live" and delete a running daemon's files.
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    writeStoreRecord('af019e9be2230360', '0.1.0', process.pid)
    expect(pruneRuntimes(2)).toEqual([])
    expect(fs.existsSync(pkgRootFor('0.1.0'))).toBe(true)
  })

  it('protects BOTH runtimes when two daemons are live on different ones', () => {
    // The case the old singular `liveRuntimeDir()` could not express: the desktop app's
    // daemon and the CLI's can now run at once, from different cached runtimes. One answer
    // protects one of them and lets prune delete the other's files out from under it.
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    fakeRuntime('0.4.0')
    writeStoreRecord('appstore', '0.1.0', process.pid)
    writeStoreRecord('clistore', '0.2.0', process.pid)
    expect(pruneRuntimes(2)).toEqual([])
    expect(fs.existsSync(pkgRootFor('0.1.0'))).toBe(true)
    expect(fs.existsSync(pkgRootFor('0.2.0'))).toBe(true)
  })

  it('still honours the LEGACY global file, so a pre-0.15.0 daemon is protected too', () => {
    // During an upgrade a cached older runtime can be the one actually serving. The risk
    // here is DELETING a directory a live process is executing from, so every scrap of
    // liveness evidence should protect — the opposite direction from the attach path, where
    // reading a global record would bind the wrong store.
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    writeDiscovery('0.1.0', process.pid)
    writeStoreRecord('newer', '0.2.0', process.pid)
    expect(pruneRuntimes(2)).toEqual([])
    expect(fs.existsSync(pkgRootFor('0.1.0'))).toBe(true)
  })

  /**
   * A pid that is certainly dead, on every platform.
   *
   * The literal 999999 used elsewhere here is dead on macOS (pid_max 99998) but can be a
   * LIVE process on Linux, where pid_max defaults to 4194304 — the test would then flip to
   * expecting no pruning and fail only in CI, on a different OS.
   */
  function reliablyDeadPid(): number {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    const pid = child.pid
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(pid, 0)
      } catch {
        return pid // exited and reaped: nothing can be running as it
      }
    }
    return 999999 // fallback; still correct on macOS
  }

  it('ignores a per-store record whose pid is dead, and one that is corrupt', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    writeStoreRecord('dead', '0.1.0', reliablyDeadPid())
    fs.writeFileSync(path.join(home, 'daemons', 'corrupt.json'), '{not json')
    expect(pruneRuntimes(2)).toEqual(['0.1.0'])
  })

  it('ignores a per-store record whose MARKER is not ours', () => {
    // Mutation-verified as uncovered: deleting the marker check from liveRuntimeDirs left
    // every test green. The old stop.test.ts had a foreign-marker case; it was deleted with
    // that file's rewrite and never replaced. Any unrelated tool dropping a JSON file with
    // a live pid into ~/.margins/daemons/ would pin cached runtimes forever.
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    fs.mkdirSync(path.join(home, 'daemons'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'daemons', 'foreign.json'),
      JSON.stringify({ v: 1, marker: 'some-other-daemon', pid: process.pid, runtimeDir: pkgRootFor('0.1.0') }),
    )
    expect(pruneRuntimes(2)).toEqual(['0.1.0'])
  })

  it('ignores a record whose runtimeDir is not a string, without throwing', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    fs.mkdirSync(path.join(home, 'daemons'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'daemons', 'weird.json'),
      JSON.stringify({ v: 1, marker: 'margins-daemon', pid: process.pid, runtimeDir: 12345 }),
    )
    fs.writeFileSync(path.join(home, 'daemons', 'notes.txt'), 'not a record at all')
    expect(pruneRuntimes(2)).toEqual(['0.1.0'])
  })

  it('a live 0.1.0-beta daemon does NOT protect 0.1.0 (the prefix near-miss)', () => {
    // Mutation-verified as uncovered: changing `startsWith(dir + path.sep)` to
    // `startsWith(dir)` left every test green, and one path being a string prefix of
    // another would then protect the wrong version.
    fakeRuntime('0.1.0')
    fakeRuntime('0.1.0-beta')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    writeStoreRecord('beta', '0.1.0-beta', process.pid)
    expect(pruneRuntimes(2)).toContain('0.1.0')
    expect(fs.existsSync(pkgRootFor('0.1.0-beta'))).toBe(true)
  })

  it('protects a live runtime even when the record spells the path differently', () => {
    // The guard gates an rm -rf and fails TOWARD deletion, so both sides are canonicalised.
    // A trailing separator, a relative MARGINS_HOME, or a symlinked home (/Users/x vs
    // /System/Volumes/Data/Users/x on macOS) would otherwise never prefix-match, and prune
    // would delete the directory a live daemon is executing from.
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    const odd = pkgRootFor('0.1.0') + path.sep + '.' + path.sep
    fs.mkdirSync(path.join(home, 'daemons'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'daemons', 'odd.json'),
      JSON.stringify({ v: 1, marker: 'margins-daemon', pid: process.pid, runtimeDir: odd }),
    )
    expect(pruneRuntimes(2)).toEqual([])
    expect(fs.existsSync(pkgRootFor('0.1.0'))).toBe(true)
  })

  it('cleanRuntimes — the MORE destructive deleter — honours per-store records too', () => {
    // Every per-store test above targets pruneRuntimes. cleanRuntimes removes everything
    // except the active version, so it can delete strictly more, and its in-use guard was
    // only ever exercised through the legacy global file.
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    writeStoreRecord('appstore', '0.1.0', process.pid)
    writeStoreRecord('clistore', '0.2.0', process.pid)
    expect(cleanRuntimes('0.3.0')).toEqual([])
    expect(fs.existsSync(pkgRootFor('0.1.0'))).toBe(true)
    expect(fs.existsSync(pkgRootFor('0.2.0'))).toBe(true)
  })

  it('pruneRuntimes prunes normally when there is no daemon at all', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    expect(pruneRuntimes(2)).toEqual(['0.1.0'])
  })

  it('cleanRuntimes keeps the in-use version even though it is not the active one', () => {
    fakeRuntime('0.1.0')
    fakeRuntime('0.2.0')
    fakeRuntime('0.3.0')
    writeDiscovery('0.1.0', process.pid)
    expect(cleanRuntimes('0.3.0')).toEqual(['0.2.0']) // 0.1.0 in use → kept; only 0.2.0 removed
    expect(fs.existsSync(pkgRootFor('0.1.0'))).toBe(true)
  })

  it('liveRuntimeVersion maps the discovery dir back to a cached version (null if dead)', () => {
    fakeRuntime('0.1.0')
    writeDiscovery('0.1.0', process.pid)
    expect(liveRuntimeVersion()).toBe('0.1.0')
    writeDiscovery('0.1.0', 999999)
    expect(liveRuntimeVersion()).toBeNull()
  })
})

describe('compat gate (U7)', () => {
  it('runtimeSchemaVersion reads the package margins field', () => {
    fakeRuntime('0.1.0', 37)
    expect(runtimeSchemaVersion(pkgRootFor('0.1.0'))?.count).toBe(37)
  })

  it('records + reads the store head; refuses an OLDER runtime, allows newer/equal', () => {
    recordStoreSchemaHead({ count: 37, tag: 't37', when: 1 })
    expect(readStoreSchemaHead()?.count).toBe(37)
    expect(() => assertRuntimeCompat({ count: 37 })).not.toThrow() // equal
    expect(() => assertRuntimeCompat({ count: 38 })).not.toThrow() // newer forward-migrates
    expect(() => assertRuntimeCompat({ count: 36 })).toThrow(RuntimeIncompatibleError) // downgrade
  })

  it('no store head → never blocks (first run)', () => {
    expect(() => assertRuntimeCompat({ count: 1 })).not.toThrow()
  })
})
