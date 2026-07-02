import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveBindingStore,
  lookupBinding,
  recordBinding,
  removeBinding,
  isAccepted,
  recordAcceptance,
} from '../src/lib/stash-bindings.js'
import { _resetStore } from '../src/lib/config.js'

// Binding store (stash update path U5/R10/R13): hybrid project-local/global
// resolution, tolerant load, acceptance trust records, idempotent gitignore.
// Real filesystem in temp dirs — the module IS filesystem behavior.

let tmp: string
let configDir: string
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-bindings-'))
  configDir = path.join(tmp, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  process.env['MARGINS_CONFIG_DIR'] = configDir
  _resetStore()
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  delete process.env['MARGINS_CONFIG_DIR']
  _resetStore()
  errSpy.mockRestore()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeProject(name = 'proj'): string {
  const root = path.join(tmp, name)
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  return root
}

const BINDING = { slug: 'stash/alice/1a2b3c4d', workspaceId: 'ws-1' }

describe('store resolution (hybrid)', () => {
  it('uses a project-local store with root-relative keys inside a project', () => {
    const root = makeProject()
    const file = path.join(root, 'docs', 'note.md')
    const store = resolveBindingStore(file)
    expect(store.kind).toBe('project')
    expect(store.storePath).toBe(path.join(root, '.margins', 'stash-bindings.json'))
    expect(store.key).toBe(path.join('docs', 'note.md'))
  })

  it('recognizes a .margins.json project root without .git', () => {
    const root = path.join(tmp, 'synced')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, '.margins.json'), '{}')
    const store = resolveBindingStore(path.join(root, 'doc.md'))
    expect(store.kind).toBe('project')
    expect(store.root).toBe(root)
  })

  it('falls back to the global store with absolute keys outside any project', () => {
    const loose = path.join(tmp, 'loose-note.md')
    const store = resolveBindingStore(loose)
    expect(store.kind).toBe('global')
    expect(store.storePath).toBe(path.join(configDir, 'stash-bindings.json'))
    expect(store.key).toBe(loose)
  })
})

describe('record / lookup / remove', () => {
  it('round-trips a project binding and stamps version 1', () => {
    const root = makeProject()
    const file = path.join(root, 'docs', 'note.md')
    recordBinding(file, BINDING)

    const hit = lookupBinding(file)
    expect(hit?.binding).toEqual(BINDING)

    const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.margins', 'stash-bindings.json'), 'utf-8'))
    expect(onDisk.version).toBe(1)

    removeBinding(file)
    expect(lookupBinding(file)).toBeNull()
  })

  it('round-trips a global binding for an out-of-project file', () => {
    const loose = path.join(tmp, 'loose.md')
    recordBinding(loose, BINDING)
    expect(lookupBinding(loose)?.binding).toEqual(BINDING)
    expect(lookupBinding(loose)?.store.kind).toBe('global')
  })

  it('a binding survives the project directory being moved (root-relative keys)', () => {
    const root = makeProject('before-move')
    const file = path.join(root, 'docs', 'note.md')
    recordBinding(file, BINDING)

    const moved = path.join(tmp, 'after-move')
    fs.renameSync(root, moved)
    expect(lookupBinding(path.join(moved, 'docs', 'note.md'))?.binding).toEqual(BINDING)
  })
})

describe('tolerant load (R10)', () => {
  it('treats corrupt JSON as empty with a warning, and the next bind rewrites it', () => {
    const root = makeProject()
    const storePath = path.join(root, '.margins', 'stash-bindings.json')
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, '{ not json !!!')
    const file = path.join(root, 'doc.md')

    expect(lookupBinding(file)).toBeNull() // no crash
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('corrupt'))

    recordBinding(file, BINDING)
    expect(lookupBinding(file)?.binding).toEqual(BINDING)
    expect(JSON.parse(fs.readFileSync(storePath, 'utf-8')).version).toBe(1)
  })

  it('treats an unknown future version as empty with a warning (forward-compat guard)', () => {
    const root = makeProject()
    const storePath = path.join(root, '.margins', 'stash-bindings.json')
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, JSON.stringify({ version: 99, bindings: { 'doc.md': BINDING } }))

    expect(lookupBinding(path.join(root, 'doc.md'))).toBeNull()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('unsupported version'))
  })

  it('treats a wrong-shape file as empty with a warning', () => {
    const root = makeProject()
    const storePath = path.join(root, '.margins', 'stash-bindings.json')
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, JSON.stringify(['not', 'an', 'object']))
    expect(lookupBinding(path.join(root, 'doc.md'))).toBeNull()
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('trust acceptances (R13)', () => {
  it('bindings recorded by this CLI are auto-accepted', () => {
    const root = makeProject()
    recordBinding(path.join(root, 'doc.md'), BINDING)
    expect(isAccepted(BINDING.slug)).toBe(true)
  })

  it('a planted project binding is NOT accepted until confirmed', () => {
    const root = makeProject()
    const storePath = path.join(root, '.margins', 'stash-bindings.json')
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    // Simulates a committed/planted file arriving via clone — this CLI never wrote it.
    fs.writeFileSync(
      storePath,
      JSON.stringify({ version: 1, bindings: { 'doc.md': BINDING } }),
    )

    expect(lookupBinding(path.join(root, 'doc.md'))?.binding).toEqual(BINDING) // visible…
    expect(isAccepted(BINDING.slug)).toBe(false) // …but untrusted

    recordAcceptance(BINDING.slug)
    expect(isAccepted(BINDING.slug)).toBe(true)
  })

  it('acceptances live in the global store, not the committable project file', () => {
    const root = makeProject()
    recordBinding(path.join(root, 'doc.md'), BINDING)
    const projectFile = JSON.parse(
      fs.readFileSync(path.join(root, '.margins', 'stash-bindings.json'), 'utf-8'),
    )
    expect(projectFile.accepted).toBeUndefined()
    const globalFile = JSON.parse(fs.readFileSync(path.join(configDir, 'stash-bindings.json'), 'utf-8'))
    expect(globalFile.accepted[BINDING.slug]).toBe(true)
  })
})

describe('.gitignore upkeep (idempotent)', () => {
  it('appends the entry once on first project-local write', () => {
    const root = makeProject()
    recordBinding(path.join(root, 'doc.md'), BINDING)
    recordBinding(path.join(root, 'other.md'), { slug: 'stash/alice/ffff0000', workspaceId: 'ws-2' })

    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')
    const occurrences = gitignore.split('.margins/stash-bindings.json').length - 1
    expect(occurrences).toBe(1)
  })

  it('respects an existing rule that already covers the file', () => {
    const root = makeProject()
    fs.writeFileSync(path.join(root, '.gitignore'), '.margins/\n')
    recordBinding(path.join(root, 'doc.md'), BINDING)
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')).toBe('.margins/\n')
  })

  it('preserves existing .gitignore content when appending', () => {
    const root = makeProject()
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n')
    recordBinding(path.join(root, 'doc.md'), BINDING)
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('node_modules/')
    expect(gitignore).toContain('.margins/stash-bindings.json')
  })
})
