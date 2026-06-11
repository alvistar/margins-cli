import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { collectSyncFiles, globMarkdown, MAX_BLOB_SIZE } from '../src/lib/collect-sync-files.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-collect-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(rel: string, content: string | Buffer): void {
  const full = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

describe('globMarkdown', () => {
  it('finds .md files recursively, sorted', () => {
    write('b.md', '# b')
    write('a.md', '# a')
    write('docs/nested.md', '# nested')
    write('notes.txt', 'not md')

    expect(globMarkdown(tmpDir)).toEqual(['a.md', 'b.md', 'docs/nested.md'])
  })

  it('excludes dotdirs, dotfiles, and node_modules', () => {
    write('keep.md', '# keep')
    write('.hidden.md', '# hidden')
    write('.git/objects.md', '# git')
    write('.obsidian/config.md', '# obsidian')
    write('node_modules/pkg/readme.md', '# pkg')

    expect(globMarkdown(tmpDir)).toEqual(['keep.md'])
  })

  it('skips symlinks (both file and directory symlinks)', () => {
    write('real.md', '# real')
    write('target-dir/inside.md', '# inside')
    fs.symlinkSync(path.join(tmpDir, 'real.md'), path.join(tmpDir, 'link.md'))
    fs.symlinkSync(path.join(tmpDir, 'target-dir'), path.join(tmpDir, 'link-dir'))

    expect(globMarkdown(tmpDir)).toEqual(['real.md', 'target-dir/inside.md'])
  })
})

describe('collectSyncFiles', () => {
  it('collects markdown files with text/markdown content type', () => {
    write('readme.md', '# Readme')
    write('docs/spec.md', '# Spec')

    const result = collectSyncFiles(tmpDir)

    expect(result.mdCount).toBe(2)
    expect(result.totalCount).toBe(2)
    expect(result.oversized).toEqual([])
    expect(result.files.map(f => f.path)).toEqual(['docs/spec.md', 'readme.md'])
    expect(result.files.every(f => f.contentType === 'text/markdown')).toBe(true)
    expect(result.files.find(f => f.path === 'readme.md')!.content.toString()).toBe('# Readme')
  })

  it('applies .marginsignore filtering', () => {
    write('keep.md', '# keep')
    write('drafts/wip.md', '# wip')
    write('.marginsignore', 'drafts/\n')

    const result = collectSyncFiles(tmpDir)

    expect(result.files.map(f => f.path)).toEqual(['keep.md'])
    expect(result.mdCount).toBe(1)
  })

  it('collects referenced images once (dedup across markdown files)', () => {
    write('a.md', '![logo](images/logo.png)')
    write('b.md', '![same logo](images/logo.png)')
    write('images/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = collectSyncFiles(tmpDir)

    const images = result.files.filter(f => f.contentType === 'image/png')
    expect(images).toHaveLength(1)
    expect(images[0]!.path).toBe('images/logo.png')
    expect(result.mdCount).toBe(2)
    expect(result.totalCount).toBe(3)
  })

  it('skips missing image references', () => {
    write('a.md', '![gone](missing.png)')

    const result = collectSyncFiles(tmpDir)

    expect(result.files.map(f => f.path)).toEqual(['a.md'])
    expect(result.totalCount).toBe(1)
  })

  it('skips references with unsupported mime types', () => {
    write('a.md', '![video](clip.mp4)\n![pic](pic.png)')
    write('clip.mp4', 'video bytes')
    write('pic.png', 'png bytes')

    const result = collectSyncFiles(tmpDir)

    expect(result.files.map(f => f.path)).toEqual(['a.md', 'pic.png'])
  })

  it('resolves image paths relative to the markdown file', () => {
    write('docs/guide.md', '![diagram](../assets/diagram.png)')
    write('assets/diagram.png', 'png bytes')

    const result = collectSyncFiles(tmpDir)

    expect(result.files.map(f => f.path)).toEqual(['docs/guide.md', 'assets/diagram.png'])
  })

  it('flags blobs over the threshold as oversized (override param)', () => {
    write('a.md', '![big](big.png)\n![small](small.png)')
    write('big.png', Buffer.alloc(2048, 1))
    write('small.png', Buffer.alloc(10, 1))

    const result = collectSyncFiles(tmpDir, { maxBlobSize: 1024 })

    expect(result.oversized).toEqual([{ path: 'big.png', bytes: 2048 }])
    // Oversized files are still collected; the caller decides what to do.
    expect(result.totalCount).toBe(3)
  })

  it('flags blobs over 2 MB at the default server cap', () => {
    write('a.md', '![huge](huge.png)')
    write('huge.png', Buffer.alloc(MAX_BLOB_SIZE + 1, 1))

    const result = collectSyncFiles(tmpDir)

    expect(MAX_BLOB_SIZE).toBe(2 * 1024 * 1024)
    expect(result.oversized).toEqual([{ path: 'huge.png', bytes: MAX_BLOB_SIZE + 1 }])
  })

  it('returns zero counts for a directory with no markdown', () => {
    write('notes.txt', 'plain text')

    const result = collectSyncFiles(tmpDir)

    expect(result).toEqual({ files: [], mdCount: 0, mdPaths: [], totalCount: 0, oversized: [] })
  })
})
