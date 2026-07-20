/**
 * Committed-mode collection (U5).
 *
 * Every git-touching test here runs against a REAL temporary git repository.
 * Nothing about git is mocked. The spike this unit is built on
 * (docs/spikes/2026-07-19-committed-collection-findings.md) exists because two
 * models agreed on a factually wrong claim about git tree paths by reasoning
 * about git instead of running it — so this file runs it.
 *
 * Fixtures pin `core.autocrlf=false` explicitly. They must: a developer's GLOBAL
 * ~/.gitconfig can set it (this repo's author's does, to `input`), and under
 * `input` any fixture that wrote CRLF content would be normalised on commit and
 * so would genuinely diverge. Without the pin these tests would pass or fail
 * depending on whose machine ran them — the exact class of ambient-environment
 * dependency that CI catches and laptops do not. The refusal tests below opt
 * back IN to a setting, deliberately, because that is what they are about.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { collectCommittedFiles, batchReadCounters } from '../src/lib/collect-committed-files.js'
import { collectSyncFiles, collectForMode, MAX_BLOB_SIZE } from '../src/lib/collect-sync-files.js'

let repo: string
let extraDirs: string[]

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-committed-'))
  extraDirs = []
})

afterEach(() => {
  for (const d of [repo, ...extraDirs]) fs.rmSync(d, { recursive: true, force: true })
})

// ─── Real-git helpers ────────────────────────────────────────────────────────

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(cwd = repo): void {
  fs.mkdirSync(cwd, { recursive: true })
  git(['init', '-q', '-b', 'main', '.'], cwd)
  git(['config', 'user.email', 'test@margins.test'], cwd)
  git(['config', 'user.name', 'Margins Test'], cwd)
  // See the file header: neutralise whatever the ambient global gitconfig says.
  git(['config', 'core.autocrlf', 'false'], cwd)
  // Same reasoning: a developer (or a CI runner) with `commit.gpgsign=true`
  // globally would have every fixture commit here block on a signing key that
  // does not exist in a temp repo. The fixture must not depend on whose machine
  // ran it.
  git(['config', 'commit.gpgsign', 'false'], cwd)
}

function write(rel: string, content: string | Buffer, cwd = repo): void {
  const full = path.join(cwd, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function commitAll(msg = 'commit', cwd = repo): string {
  git(['add', '-A'], cwd)
  git(['commit', '-q', '-m', msg], cwd)
  return git(['rev-parse', 'HEAD'], cwd).trim()
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const paths = (r: { files: Array<{ path: string }> }): string[] => r.files.map((f) => f.path)
const manifest = (r: { files: Array<{ path: string; content: Buffer }> }): Record<string, string> =>
  Object.fromEntries(r.files.map((f) => [f.path, sha(f.content)]))

/** The standard fixture: two depths, an image referenced from a nested file. */
function standardFixture(): void {
  initRepo()
  write('README.md', '# Readme\n')
  write('docs/guide.md', '![shot](./img/shot.png)\n')
  write('docs/deep/nested.md', '![deep](../img/shot.png)\n')
  write('docs/img/shot.png', PNG)
  write('notes/scratch.md', '# scratch\n')
  commitAll()
}

// ─── Parity with the working-tree collector ──────────────────────────────────

describe('collectCommittedFiles — parity with the working tree', () => {
  it('CRITICAL: a clean tree produces the same paths AND the same content shas in both modes', () => {
    standardFixture()

    const wt = collectSyncFiles(repo)
    const committed = collectCommittedFiles(repo)

    expect(paths(committed)).toEqual(paths(wt))
    // The load-bearing gate: identical CONTENT hashes, not merely identical
    // paths. The synthetic-sha vector is computed over a path→hash map and
    // cannot see how the hashes were produced.
    expect(manifest(committed)).toEqual(manifest(wt))
    expect(committed.mdPaths).toEqual(wt.mdPaths)
    expect(committed.mdCount).toBe(wt.mdCount)
    expect(committed.totalCount).toBe(wt.totalCount)
  })

  it('CRITICAL: a subdirectory sync matches the working-tree collector at two depths, image included', () => {
    standardFixture()

    const docs = path.join(repo, 'docs')
    expect(paths(collectCommittedFiles(docs))).toEqual(paths(collectSyncFiles(docs)))
    expect(manifest(collectCommittedFiles(docs))).toEqual(manifest(collectSyncFiles(docs)))
    // The image resolved from a NESTED markdown file, dir-relative.
    expect(paths(collectCommittedFiles(docs))).toContain('img/shot.png')

    const deep = path.join(repo, 'docs/deep')
    expect(paths(collectCommittedFiles(deep))).toEqual(paths(collectSyncFiles(deep)))
    expect(paths(collectCommittedFiles(deep))).toEqual(['nested.md'])
  })

  it('is reached through collectForMode with mode "committed"', () => {
    standardFixture()

    expect(manifest(collectForMode(repo, 'committed'))).toEqual(manifest(collectCommittedFiles(repo)))
    expect(manifest(collectForMode(repo, 'working-tree'))).toEqual(manifest(collectSyncFiles(repo)))
  })
})

// ─── R8: git's rules govern what leaves the machine ──────────────────────────

describe('collectCommittedFiles — what the commit excludes (R8)', () => {
  it('omits a gitignored markdown file', () => {
    initRepo()
    write('keep.md', '# keep\n')
    write('.gitignore', 'private.md\n')
    write('private.md', '# secrets\n')
    commitAll()

    expect(paths(collectCommittedFiles(repo))).toEqual(['keep.md'])
    expect(paths(collectSyncFiles(repo))).toContain('private.md')
  })

  it('omits uncommitted edits, and an image referenced only from an uncommitted file', () => {
    initRepo()
    write('a.md', '# committed\n')
    commitAll()
    write('a.md', '# edited on disk, never committed\n')
    write('untracked.md', '![only here](new.png)\n')
    write('new.png', PNG)

    const committed = collectCommittedFiles(repo)

    expect(paths(committed)).toEqual(['a.md'])
    expect(committed.files[0]!.content.toString()).toBe('# committed\n')
    expect(paths(committed)).not.toContain('new.png')
    // The working tree sees all three.
    expect(paths(collectSyncFiles(repo))).toEqual(['a.md', 'untracked.md', 'new.png'])
  })

  it('omits a tracked markdown file under a dot-directory, matching working-tree mode', () => {
    initRepo()
    write('keep.md', '# keep\n')
    write('.obsidian/notes.md', '# hidden\n')
    commitAll()

    expect(git(['ls-files']).split('\n')).toContain('.obsidian/notes.md')
    expect(paths(collectCommittedFiles(repo))).toEqual(['keep.md'])
    expect(paths(collectSyncFiles(repo))).toEqual(['keep.md'])
  })
})

// ─── KTD6: tree entry modes ──────────────────────────────────────────────────

describe('collectCommittedFiles — non-regular tree entries (KTD6)', () => {
  it('omits a symlinked markdown file rather than syncing its target path as content', () => {
    initRepo()
    write('real.md', '# real\n')
    fs.symlinkSync('real.md', path.join(repo, 'link.md'))
    commitAll()

    // Prove the hazard is real in this fixture: git stores mode 120000 whose
    // blob content is the link target, and that target ends in `.md`.
    expect(git(['ls-tree', '-r', 'HEAD'])).toContain('120000 blob')
    expect(git(['cat-file', 'blob', 'HEAD:link.md'])).toBe('real.md')

    const committed = collectCommittedFiles(repo)
    expect(paths(committed)).toEqual(['real.md'])
    expect(committed.files.map((f) => f.content.toString())).not.toContain('real.md')
  })

  it('collects successfully in a repository containing a submodule, skipping its entry', () => {
    const sub = repo + '-sub'
    extraDirs.push(sub)
    initRepo(sub)
    write('s.md', '# sub\n', sub)
    commitAll('sub', sub)

    initRepo()
    write('top.md', '# top\n')
    commitAll()
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor'])
    commitAll('add submodule')

    // The hazard: mode 160000 lists, but reading its blob returns `missing` —
    // which under phase one's fatal rule would abort every sync in this repo.
    expect(git(['ls-tree', '-r', 'HEAD'])).toContain('160000 commit')

    expect(paths(collectCommittedFiles(repo))).toEqual(['top.md'])
  })
})

// ─── KTD10 / KTD11 / KTD12: reads ────────────────────────────────────────────

describe('collectCommittedFiles — read failures (KTD10, KTD11, KTD12)', () => {
  it('CRITICAL: aborts when a listed tree entry cannot be read, never yielding a smaller manifest', () => {
    initRepo()
    write('a.md', '# a\n')
    write('b.md', '# b\n')
    commitAll()

    // Destroy exactly one listed blob in the object store. The listing still
    // names it; the read now fails. A collector that skipped it would return a
    // one-file manifest, and the server's absent-path sweep would delete b.md.
    const oid = git(['rev-parse', 'HEAD:b.md']).trim()
    git(['config', 'gc.auto', '0'])
    const loose = path.join(repo, '.git/objects', oid.slice(0, 2), oid.slice(2))
    expect(fs.existsSync(loose)).toBe(true)
    fs.rmSync(loose)

    expect(() => collectCommittedFiles(repo)).toThrow(/b\.md/)
  })

  it('CRITICAL: a --batch response with missing lines fails, despite the process exiting 0', () => {
    initRepo()
    write('a.md', '# a\n')
    commitAll()

    // Establish the premise this test guards, against real git: `--batch`
    // reports an absent path on stdout and STILL exits 0, so exit status
    // proves nothing and the missing lines must be parsed.
    const out = execFileSync('git', ['cat-file', '--batch'], {
      cwd: repo, input: 'HEAD:nope.md\n', encoding: 'utf-8',
    })
    expect(out).toContain('missing')

    // And the collector fails on such a response rather than reading past it.
    const oid = git(['rev-parse', 'HEAD:a.md']).trim()
    fs.rmSync(path.join(repo, '.git/objects', oid.slice(0, 2), oid.slice(2)))
    expect(() => collectCommittedFiles(repo)).toThrow(/a\.md/)
  })

  it('CRITICAL: markdown referencing an untracked or nonexistent image collects fine, image absent', () => {
    initRepo()
    write('a.md', '![gone](missing.png)\n![untracked](local.png)\n![real](real.png)\n')
    write('real.png', PNG)
    commitAll()
    // Exists on disk, was never committed — phase two must skip it, not abort.
    write('local.png', PNG)

    const committed = collectCommittedFiles(repo)

    expect(paths(committed)).toEqual(['a.md', 'real.png'])
    expect(committed.mdCount).toBe(1)
  })

  it('reads a blob at the 2 MB cap intact, and round-trips a binary image byte-identically', () => {
    initRepo()
    const big = Buffer.alloc(MAX_BLOB_SIZE, 0x41)
    const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
    write('a.md', '![big](big.png)\n![bin](bin.png)\n')
    write('big.png', big)
    write('bin.png', binary)
    commitAll()

    const committed = collectCommittedFiles(repo)
    const byPath = new Map(committed.files.map((f) => [f.path, f.content]))

    expect(byPath.get('big.png')!.length).toBe(MAX_BLOB_SIZE)
    expect(sha(byPath.get('big.png')!)).toBe(sha(big))
    expect(Buffer.compare(byPath.get('bin.png')!, binary)).toBe(0)
    // And it matches what the working tree would have sent, byte for byte.
    expect(manifest(committed)).toEqual(manifest(collectSyncFiles(repo)))
  })

  it('runs exactly two batched read phases with images, and skips the second without them', () => {
    initRepo()
    write('pics/with.md', '![i](i.png)\n')
    write('pics/i.png', PNG)
    write('plain/without.md', '# no images\n')
    commitAll()

    const reset = (): void => {
      batchReadCounters.markdown = 0
      batchReadCounters.images = 0
      batchReadCounters.metadata = 0
    }

    reset()
    expect(paths(collectCommittedFiles(path.join(repo, 'pics')))).toEqual(['with.md', 'i.png'])
    // Exactly two batched reads, and neither scales with the number of files.
    expect(batchReadCounters).toEqual({ markdown: 1, images: 1, metadata: 0 })

    reset()
    expect(paths(collectCommittedFiles(path.join(repo, 'plain')))).toEqual(['without.md'])
    // No image was referenced, so phase two never spawned a process at all.
    expect(batchReadCounters).toEqual({ markdown: 1, images: 0, metadata: 0 })
  })

  it('adds exactly one O(1) metadata read when the commit carries a .marginsignore', () => {
    initRepo()
    write('a.md', '# a\n')
    write('b.md', '# b\n')
    write('c.md', '# c\n')
    write('.marginsignore', 'c.md\n')
    commitAll()

    batchReadCounters.markdown = 0
    batchReadCounters.images = 0
    batchReadCounters.metadata = 0
    expect(paths(collectCommittedFiles(repo))).toEqual(['a.md', 'b.md'])
    expect(batchReadCounters).toEqual({ markdown: 1, images: 0, metadata: 1 })
  })
})

// ─── KTD6: refusals ──────────────────────────────────────────────────────────

describe('collectCommittedFiles — refusals (KTD6)', () => {
  /**
   * The EOL gate tests the EFFECT, not the configuration.
   *
   * KTD6 named the config (`core.autocrlf`, a `text`/`eol` attribute), but a
   * config-based refusal is both too strict and misleading in practice:
   * `core.autocrlf=input` is a common GLOBAL setting — it is set in this
   * machine's own ~/.gitconfig — and it only rewrites bytes on the way IN, so
   * a repository whose files are already LF has no divergence at all. Refusing
   * it would make committed mode unusable everywhere while naming a config the
   * user never set per-repository.
   *
   * `git ls-files --eol` answers the real question directly: it reports the
   * line endings of each file as stored in the index (`i/`) and as written to
   * the working tree (`w/`). They differ exactly when a committed sync's bytes
   * would differ from a working-tree sync's bytes, which is the divergence
   * KTD6 exists to prevent.
   */
  it('ALLOWS core.autocrlf=input when no file actually diverges', () => {
    standardFixture()
    git(['config', 'core.autocrlf', 'input'])

    // The common global setting. Every file here is already LF, so the index
    // and the working tree agree and there is nothing to refuse.
    const out = collectCommittedFiles(repo)
    expect(out.mdCount).toBeGreaterThan(0)
  })

  it('ALLOWS a .gitattributes text=auto rule when the files are already LF', () => {
    initRepo()
    write('.gitattributes', '*.md text=auto\n')
    write('a.md', '# a\n')
    commitAll()

    expect(collectCommittedFiles(repo).mdCount).toBe(1)
  })

  it('refuses when a file REALLY diverges — CRLF on disk, LF in the commit', () => {
    initRepo()
    git(['config', 'core.autocrlf', 'input'])
    // Written with CRLF; autocrlf=input normalises to LF on the way into the
    // object store, so the blob and the file on disk are now different bytes.
    write('a.md', '# a\r\nsecond line\r\n')
    commitAll()

    expect(() => collectCommittedFiles(repo)).toThrow(/line ending|end-of-line|EOL/i)
  })

  it('names the diverging file, so the reason is actionable', () => {
    initRepo()
    git(['config', 'core.autocrlf', 'input'])
    write('clean.md', '# clean\n')
    write('crlf.md', '# crlf\r\n')
    commitAll()

    expect(() => collectCommittedFiles(repo)).toThrow(/crlf\.md/)
  })

  it('does not mistake a binary image for a diverging text file', () => {
    initRepo()
    git(['config', 'core.autocrlf', 'input'])
    write('a.md', '![i](i.png)\n')
    write('i.png', PNG)
    commitAll()

    // Images report i/none w/none — absence of line endings on both sides is
    // agreement, not divergence.
    expect(collectCommittedFiles(repo).mdCount).toBe(1)
  })

  /**
   * The EOL guard passes every collectable path to `git ls-files` as ARGV.
   *
   * Past the kernel's ARG_MAX that spawn fails outright with `E2BIG`, `runGit`
   * throws, and EVERY committed sync in the repository fails permanently with a
   * message naming neither the cause nor a workaround. The ceiling is not
   * theoretical at this unit's stated scale: measured on macOS (ARG_MAX
   * 1048576), 5,000 files at realistic nested path lengths overflow it — and
   * 5,000 files is the scale this module documents as its target.
   *
   * The sibling `check-attr` call one block above already avoids this with
   * `--stdin`. `git ls-files` has no `--stdin` (verified on git 2.50.1: "error:
   * unknown option `stdin'"), so the guard is run once per slice instead — and
   * the refusal has to keep working across the seam, which is what the diverging
   * file's position in a LATER slice is here to pin.
   */
  it('still catches a divergence past ARG_MAX, in a file beyond the first slice', () => {
    initRepo()
    git(['config', 'core.autocrlf', 'input'])

    // Long, deeply nested, entirely ordinary documentation paths — the argv
    // cost is the path LENGTH as much as the file count.
    const deep = 'design-documentation-archive'.padEnd(180, '-x')
    const rel = (i: number): string =>
      `docs/area-${i % 17}/${deep}/subsystem-${i % 29}/chapter-${String(i).padStart(6, '0')}-document-title.md`

    const N = 5000
    for (let i = 0; i < N; i++) write(rel(i), '# clean\n')

    // The diverging file sits deep in the set, so a fix that only guarded the
    // FIRST slice would sail past it and sync bytes nobody asked for.
    const diverging = rel(N - 42)
    write(diverging, '# crlf\r\nsecond line\r\n')
    commitAll()

    // Pre-chunking this throws the raw spawn failure ("Could not run git … (E2BIG)")
    // instead — the wrong error, for every file in the repository, forever.
    let caught: unknown
    try {
      collectCommittedFiles(repo)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).not.toMatch(/E2BIG/)
    expect((caught as Error).message).toMatch(/line endings/)
    // Named, so the refusal is actionable — the whole point of the guard.
    expect((caught as Error).message).toContain(diverging)
  }, 120_000)

  it('refuses a repository with git-LFS tracking a collectable path rather than sending pointer stubs', () => {
    initRepo()
    write('a.md', '![i](i.png)\n')
    write('i.png', PNG)
    commitAll()
    // Tracked in a SECOND commit so the fixture never executes an lfs clean
    // filter — the refusal must be driven by the attribute, and the test must
    // not require git-lfs to be installed on the machine running it.
    write('.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n')
    commitAll('track png with lfs')
    expect(git(['check-attr', 'filter', '--', 'i.png'])).toContain('filter: lfs')

    expect(() => collectCommittedFiles(repo)).toThrow(/LFS/i)
  })

  it('refuses a bare repository with its own message', () => {
    standardFixture()
    const bare = repo + '-bare.git'
    execFileSync('git', ['clone', '-q', '--bare', repo, bare])
    try {
      expect(() => collectCommittedFiles(bare)).toThrow(/bare/i)
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })

  it('refuses a repository with no commits, reporting why', () => {
    initRepo()
    write('a.md', '# uncommitted\n')

    expect(() => collectCommittedFiles(repo)).toThrow(/no commits/i)
  })

  it('refuses a directory that is not in a git repository at all', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'margins-nogit-'))
    try {
      expect(() => collectCommittedFiles(plain)).toThrow(/git repositor/i)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})

// ─── KTD10: path convention under a hostile environment ──────────────────────

describe('collectCommittedFiles — path convention (KTD10)', () => {
  it('still produces subdirectory-relative paths with GIT_DIR set and no GIT_WORK_TREE', () => {
    standardFixture()
    const docs = path.join(repo, 'docs')

    // Prove the hazard against real git first: with GIT_DIR set and no
    // GIT_WORK_TREE, git believes the cwd IS the repository root, so the
    // ambient prefix flips to empty and a bare `ls-tree` goes root-relative.
    const flippedPrefix = execFileSync('git', ['rev-parse', '--show-prefix'], {
      cwd: docs, encoding: 'utf-8', env: { ...process.env, GIT_DIR: path.join(repo, '.git') },
    })
    expect(flippedPrefix.trim()).toBe('')

    const prev = process.env.GIT_DIR
    process.env.GIT_DIR = path.join(repo, '.git')
    try {
      expect(paths(collectCommittedFiles(docs))).toEqual(paths(collectSyncFiles(docs)))
      expect(paths(collectCommittedFiles(docs))).toEqual(['deep/nested.md', 'img/shot.png', 'guide.md'])
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = prev
    }
  })
})

// ─── .marginsignore comes from the commit ────────────────────────────────────

describe('collectCommittedFiles — .marginsignore (from the commit, not the checkout)', () => {
  it('filters by the commit\'s .marginsignore, not the working tree\'s', () => {
    initRepo()
    write('keep.md', '# keep\n')
    write('drafts/wip.md', '# wip\n')
    write('.marginsignore', 'drafts/\n')
    commitAll()
    // The checkout now says something different. Committed mode must ignore it.
    fs.writeFileSync(path.join(repo, '.marginsignore'), 'keep.md\n')

    expect(paths(collectCommittedFiles(repo))).toEqual(['keep.md'])
    // ...and the working-tree collector demonstrably reads the other one.
    expect(paths(collectSyncFiles(repo))).toEqual(['drafts/wip.md'])
  })

  it('reads the subdirectory\'s .marginsignore for a subdirectory sync', () => {
    initRepo()
    write('docs/keep.md', '# keep\n')
    write('docs/skip.md', '# skip\n')
    write('docs/.marginsignore', 'skip.md\n')
    commitAll()

    expect(paths(collectCommittedFiles(path.join(repo, 'docs')))).toEqual(['keep.md'])
  })
})

// ─── Provenance (wire contract §6) ───────────────────────────────────────────

describe('collectCommittedFiles — git provenance (wire contract §6)', () => {
  it('surfaces the resolved commit sha and the repository object format', () => {
    standardFixture()
    const head = git(['rev-parse', 'HEAD']).trim()

    const committed = collectCommittedFiles(repo)

    expect(committed.gitProvenance).toEqual({ gitCommitSha: head, gitObjectFormat: 'sha1' })
    expect(committed.gitProvenance!.gitCommitSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('reports sha256 for a sha256 repository, rather than assuming SHA-1 (KTD9)', () => {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.mkdirSync(repo, { recursive: true })
    git(['init', '-q', '-b', 'main', '--object-format=sha256', '.'])
    git(['config', 'user.email', 'test@margins.test'])
    git(['config', 'user.name', 'Margins Test'])
    git(['config', 'core.autocrlf', 'false'])
    write('a.md', '# a\n')
    commitAll()

    const committed = collectCommittedFiles(repo)

    expect(committed.gitProvenance!.gitObjectFormat).toBe('sha256')
    expect(committed.gitProvenance!.gitCommitSha).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resolves an explicit rev, and its provenance is that rev — not HEAD', () => {
    initRepo()
    write('a.md', '# first\n')
    const first = commitAll('first')
    write('a.md', '# second\n')
    const second = commitAll('second')
    expect(first).not.toBe(second)

    const atFirst = collectCommittedFiles(repo, { rev: first })

    expect(atFirst.gitProvenance!.gitCommitSha).toBe(first)
    expect(atFirst.files[0]!.content.toString()).toBe('# first\n')
    expect(collectCommittedFiles(repo).gitProvenance!.gitCommitSha).toBe(second)
  })

  it('the working-tree collector carries no provenance', () => {
    standardFixture()

    expect(collectSyncFiles(repo).gitProvenance).toBeUndefined()
  })
})

// ─── Empty, but legitimately so ──────────────────────────────────────────────

describe('collectCommittedFiles — legitimately empty', () => {
  it('returns an empty collection (not an error) for a commit with no markdown', () => {
    initRepo()
    write('main.rs', 'fn main() {}\n')
    commitAll()

    const committed = collectCommittedFiles(repo)

    expect(committed.mdCount).toBe(0)
    expect(committed.files).toEqual([])
    expect(committed.gitProvenance!.gitCommitSha).toMatch(/^[0-9a-f]{40}$/)
  })
})

// ─── KTD6 refusals from a SUBDIRECTORY ───────────────────────────────────────

/**
 * Regression: both KTD6 refusals ran against the repository ROOT while being
 * handed SYNC-DIR-RELATIVE paths (`listing.listed` strips `ctx.prefix`). git
 * resolves pathspecs and check-attr stdin paths against the cwd, so for any
 * subdirectory sync the guards matched nothing and silently refused nothing —
 * a gate that always passes. Every other refusal test runs at the repo root,
 * where the prefix is '' and the two conventions coincide, so none of them
 * could see it.
 */
describe('collectCommittedFiles — refusals from a subdirectory (KTD6)', () => {
  it('refuses a genuinely diverging file under a subdirectory sync', () => {
    initRepo()
    git(['config', 'core.autocrlf', 'input'])
    write('docs/crlf.md', '# crlf\r\nsecond\r\n')
    write('docs/clean.md', '# clean\n')
    commitAll()

    expect(() => collectCommittedFiles(path.join(repo, 'docs')))
      .toThrow(/line ending|end-of-line|EOL/i)
  })

  it('refuses git-LFS tracking under a subdirectory sync', () => {
    initRepo()
    write('docs/a.md', '![i](i.png)\n')
    write('docs/i.png', PNG)
    write('.gitattributes', 'docs/*.png filter=lfs diff=lfs merge=lfs -text\n')
    commitAll()

    expect(() => collectCommittedFiles(path.join(repo, 'docs')))
      .toThrow(/LFS|filter/i)
  })
})
