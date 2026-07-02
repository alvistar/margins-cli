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
    const store = recordBinding(path.join(root, 'doc.md'), BINDING)
    expect(isAccepted(store, BINDING)).toBe(true)
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

    const hit = lookupBinding(path.join(root, 'doc.md'))!
    expect(hit.binding).toEqual(BINDING) // visible…
    expect(isAccepted(hit.store, hit.binding)).toBe(false) // …but untrusted

    recordAcceptance(hit.store, hit.binding)
    expect(isAccepted(hit.store, hit.binding)).toBe(true)
  })

  it('a planted binding reusing an ALREADY-ACCEPTED slug still prompts (identity-keyed trust)', () => {
    // The user legitimately accepted their own stash in project A…
    const trusted = makeProject('trusted')
    const store = recordBinding(path.join(trusted, 'doc.md'), BINDING)
    expect(isAccepted(store, BINDING)).toBe(true)

    // …a malicious clone plants a binding to the SAME slug for a different file.
    const evil = makeProject('evil-clone')
    const evilStore = path.join(evil, '.margins', 'stash-bindings.json')
    fs.mkdirSync(path.dirname(evilStore), { recursive: true })
    fs.writeFileSync(evilStore, JSON.stringify({ version: 1, bindings: { 'README.md': BINDING } }))

    const hit = lookupBinding(path.join(evil, 'README.md'))!
    expect(isAccepted(hit.store, hit.binding)).toBe(false) // must re-prompt
  })

  it('acceptances live in the global store, not the committable project file', () => {
    const root = makeProject()
    recordBinding(path.join(root, 'doc.md'), BINDING)
    const projectFile = JSON.parse(
      fs.readFileSync(path.join(root, '.margins', 'stash-bindings.json'), 'utf-8'),
    )
    expect(projectFile.accepted).toBeUndefined()
    const globalFile = JSON.parse(fs.readFileSync(path.join(configDir, 'stash-bindings.json'), 'utf-8'))
    // Identity-keyed: values carry the accepted slug.
    expect(Object.values(globalFile.accepted)).toContain(BINDING.slug)
  })
})

describe('symlink guards (planted-clone hardening)', () => {
  it('refuses to write through a symlinked stash-bindings.json', () => {
    const root = makeProject()
    const target = path.join(tmp, 'victim.txt')
    fs.writeFileSync(target, 'precious')
    fs.mkdirSync(path.join(root, '.margins'), { recursive: true })
    fs.symlinkSync(target, path.join(root, '.margins', 'stash-bindings.json'))

    expect(() => recordBinding(path.join(root, 'doc.md'), BINDING)).toThrow(/symlink/i)
    expect(fs.readFileSync(target, 'utf-8')).toBe('precious') // untouched
  })

  it('refuses when the .margins directory itself is a symlink', () => {
    const root = makeProject()
    const elsewhere = path.join(tmp, 'elsewhere')
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.symlinkSync(elsewhere, path.join(root, '.margins'))
    expect(() => recordBinding(path.join(root, 'doc.md'), BINDING)).toThrow(/symlink/i)
  })

  it('refuses to append to a symlinked .gitignore', () => {
    const root = makeProject()
    const target = path.join(tmp, 'gitignore-victim.txt')
    fs.writeFileSync(target, 'keep me')
    fs.symlinkSync(target, path.join(root, '.gitignore'))
    expect(() => recordBinding(path.join(root, 'doc.md'), BINDING)).toThrow(/symlink/i)
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me')
  })

  it('a "__proto__" binding key stays a plain property (no prototype pollution)', () => {
    const root = makeProject()
    const storePath = path.join(root, '.margins', 'stash-bindings.json')
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    // Hand-built JSON: an object literal { __proto__: ... } would set the
    // prototype at literal-creation time and serialize as {}.
    fs.writeFileSync(
      storePath,
      `{"version":1,"bindings":{"__proto__":{"slug":"${BINDING.slug}","workspaceId":"${BINDING.workspaceId}"}}}`,
    )
    const hit = lookupBinding(path.join(root, '__proto__'))
    expect(hit?.binding).toEqual(BINDING)
    expect(({} as Record<string, unknown>)['slug']).toBeUndefined()
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

  it('respects a glob rule (.margins/*) without a duplicate append', () => {
    const root = makeProject()
    fs.writeFileSync(path.join(root, '.gitignore'), '.margins/*\n')
    recordBinding(path.join(root, 'doc.md'), BINDING)
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')).toBe('.margins/*\n')
  })

  it('acceptance round-trips even when the global file was corrupt (rewritten empty)', () => {
    const globalPath = path.join(configDir, 'stash-bindings.json')
    fs.writeFileSync(globalPath, '{ corrupt !!!')
    const root = makeProject()
    const store = recordBinding(path.join(root, 'doc.md'), BINDING)
    expect(isAccepted(store, BINDING)).toBe(true)
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
