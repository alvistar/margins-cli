import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { vi } from 'vitest'
import { createHash } from 'node:crypto'
import { collectSyncFiles, globMarkdown, skipOversized, MAX_BLOB_SIZE } from '../src/lib/collect-sync-files.js'

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

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

  it('skips an unreadable image reference (EISDIR: directory named like an image)', () => {
    // A directory whose name looks like an image: existsSync passes, the mime
    // resolves, but readFileSync throws EISDIR — must be skipped, not crash.
    write('a.md', '![dir](pic.png)\n![real](real.png)')
    fs.mkdirSync(path.join(tmpDir, 'pic.png'))
    write('real.png', 'png bytes')

    const result = collectSyncFiles(tmpDir)

    expect(result.files.map(f => f.path)).toEqual(['a.md', 'real.png'])
    expect(result.totalCount).toBe(2)
  })

  it('returns zero counts for a directory with no markdown', () => {
    write('notes.txt', 'plain text')

    const result = collectSyncFiles(tmpDir)

    expect(result).toEqual({ files: [], mdCount: 0, mdPaths: [], totalCount: 0, oversized: [] })
  })
})

/**
 * CHARACTERIZATION GUARD (U5).
 *
 * Captured from the collector as it stood BEFORE it was split into a file source
 * and a shared filter pipeline, and asserted byte-for-byte after. Every value
 * below — including the file ORDER, which interleaves each markdown file with
 * the images it first referenced — is a recording, not a design choice. If this
 * fails, the split changed working-tree behaviour and the change is the bug.
 */
describe('collectSyncFiles — pre-split characterization', () => {
  function buildFixture(): void {
    write('README.md', '# Readme\n![logo](assets/logo.png)\n')
    write('docs/guide.md', '![shot](./img/shot.png)\n![again](img/shot.png)\n![up](../assets/logo.png)\n')
    write('docs/deep/nested.md', '![deep](../img/shot.png)\n![gone](../img/missing.png)\n![vid](../img/clip.mp4)\n')
    write('docs/img/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
    write('docs/img/clip.mp4', 'not an image mime')
    write('assets/logo.png', Buffer.alloc(64, 7))
    write('notes/scratch.md', '# scratch\n')
    write('drafts/wip.md', '# wip\n')
    write('big/huge.md', '![big](big.png)\n')
    write('big/big.png', Buffer.alloc(4096, 3))
    write('.hidden.md', '# hidden')
    write('.obsidian/config.md', '# obsidian')
    write('node_modules/pkg/readme.md', '# pkg')
    write('notes.txt', 'plain')
    write('.marginsignore', 'drafts/\n')
    write('eisdir/a.md', '![dir](pic.png)\n![real](real.png)\n')
    fs.mkdirSync(path.join(tmpDir, 'eisdir/pic.png'))
    write('eisdir/real.png', Buffer.alloc(8, 9))
    fs.symlinkSync(path.join(tmpDir, 'README.md'), path.join(tmpDir, 'link.md'))
    fs.symlinkSync(path.join(tmpDir, 'docs'), path.join(tmpDir, 'link-dir'))
  }

  const sig = (r: ReturnType<typeof collectSyncFiles>) =>
    r.files.map((f) => `${f.path}|${f.contentType}|${sha(f.content).slice(0, 12)}`)

  beforeEach(buildFixture)

  it('reproduces the recorded whole-tree output exactly', () => {
    const r = collectSyncFiles(tmpDir)

    expect(r.mdCount).toBe(6)
    expect(r.totalCount).toBe(10)
    expect(r.oversized).toEqual([])
    expect(r.mdPaths).toEqual([
      'README.md', 'big/huge.md', 'docs/deep/nested.md',
      'docs/guide.md', 'eisdir/a.md', 'notes/scratch.md',
    ])
    // Note docs/img/shot.png precedes docs/guide.md: docs/deep/nested.md sorts
    // first and referenced it first. That ordering is part of the recording.
    expect(sig(r)).toEqual([
      'README.md|text/markdown|7dd2f8fbd298',
      'assets/logo.png|image/png|6cfeeb3aa25d',
      'big/huge.md|text/markdown|2410fa1b2cce',
      'big/big.png|image/png|4539cc1fbc3c',
      'docs/deep/nested.md|text/markdown|c4da9a0cd612',
      'docs/img/shot.png|image/png|7f47b756761a',
      'docs/guide.md|text/markdown|b21ec974302d',
      'eisdir/a.md|text/markdown|edfc39493a63',
      'eisdir/real.png|image/png|a01bd6d7c452',
      'notes/scratch.md|text/markdown|b219502da79a',
    ])
  })

  it('reproduces the recorded oversized report at an overridden cap', () => {
    const r = collectSyncFiles(tmpDir, { maxBlobSize: 1024 })

    expect(r.oversized).toEqual([{ path: 'big/big.png', bytes: 4096 }])
    expect(r.totalCount).toBe(10)
  })

  it('reproduces the recorded subdirectory outputs at both depths', () => {
    expect(sig(collectSyncFiles(path.join(tmpDir, 'docs')))).toEqual([
      'deep/nested.md|text/markdown|c4da9a0cd612',
      'img/shot.png|image/png|7f47b756761a',
      'guide.md|text/markdown|b21ec974302d',
    ])
    expect(sig(collectSyncFiles(path.join(tmpDir, 'docs/deep')))).toEqual([
      'nested.md|text/markdown|c4da9a0cd612',
    ])
    expect(sig(collectSyncFiles(path.join(tmpDir, 'eisdir')))).toEqual([
      'a.md|text/markdown|edfc39493a63',
      'real.png|image/png|a01bd6d7c452',
    ])
  })

  it('reproduces the recorded glob output, at root and in a subdirectory', () => {
    expect(globMarkdown(tmpDir)).toEqual([
      'README.md', 'big/huge.md', 'docs/deep/nested.md',
      'docs/guide.md', 'drafts/wip.md', 'eisdir/a.md', 'notes/scratch.md',
    ])
    expect(globMarkdown(path.join(tmpDir, 'docs'))).toEqual(['deep/nested.md', 'guide.md'])
  })
})

describe('skipOversized', () => {
  it('drops oversized blobs from the file set and reports them on stderr', () => {
    write('a.md', '![big](big.png)')
    write('big.png', Buffer.alloc(2048, 1))
    const collected = collectSyncFiles(tmpDir, { maxBlobSize: 1024 })
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const files = skipOversized(collected)

    expect(files.map(f => f.path)).toEqual(['a.md']) // big.png excluded
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(logged).toContain('big.png')
    expect(logged).toContain('skipping 1 file(s)')
    stderrSpy.mockRestore()
  })

  it('is a pass-through with no stderr output when nothing is oversized', () => {
    write('a.md', '# small')
    const collected = collectSyncFiles(tmpDir)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(skipOversized(collected)).toBe(collected.files)
    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})
