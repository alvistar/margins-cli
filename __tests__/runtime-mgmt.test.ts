import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  listRuntimes,
  pruneRuntimes,
  cleanRuntimes,
  pkgRootFor,
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
