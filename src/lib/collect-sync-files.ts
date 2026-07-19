/**
 * Shared file-collection pipeline for local CAS sync (`workspace push`, `sync`).
 * (install/audit cap pre-checks read the GitHub tree instead — see
 * src/lib/audit-checks.ts; only MAX_BLOB_SIZE is shared with them.)
 *
 * Globs markdown files (skipping dotdirs, node_modules, symlinks), applies the
 * `.marginsignore` filter, and collects referenced images (deduplicated; missing
 * refs and unsupported mime types skipped). Also reports blobs over the server's
 * MAX_BLOB_SIZE so callers can warn before uploads that would fail server-side.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { scanImagesInMarkdown, mimeFromPath } from './image-scanner.js'
import { buildIgnoreFilter, readIgnoreFileText } from './marginsignore.js'
import { collectCommittedFiles } from './collect-committed-files.js'
import { ValidationError } from './errors.js'
import type { ContentMode } from './cas-sync.js'

/** Server-side per-blob size cap (margins MAX_BLOB_SIZE). */
export const MAX_BLOB_SIZE = 2 * 1024 * 1024

export interface SyncFile {
  path: string
  content: Buffer
  contentType: string
}

/**
 * Which commit a committed-mode collection was read from (wire contract §6).
 *
 * PROVENANCE, not identity: it records the input a push was collected from. It
 * never becomes `commitSha`/`parentSha`, which stay sha256-over-the-sorted-
 * manifest — the manifest is a FILTERED subset of the commit, so change
 * `.marginsignore` and re-push the same commit and the content differs while the
 * git sha does not.
 *
 * Both fields travel together or not at all, and the length must match the
 * declared format (40↔sha1, 64↔sha256): the server 400s a contradiction.
 */
export interface GitProvenance {
  gitCommitSha: string
  gitObjectFormat: 'sha1' | 'sha256'
}

export interface CollectedSyncFiles {
  /** Markdown files followed by their referenced images, in glob order. */
  files: SyncFile[]
  /** Number of markdown files (after `.marginsignore` filtering). */
  mdCount: number
  /** Relative paths of the collected markdown files, in glob order. */
  mdPaths: string[]
  /** Total files collected (markdown + images). */
  totalCount: number
  /** Blobs exceeding the server blob-size cap. */
  oversized: Array<{ path: string; bytes: number }>
  /**
   * Set by committed mode only. A working-tree push omits it, which is exactly
   * what the server's both-or-neither rule expects for a push that records no
   * provenance.
   */
  gitProvenance?: GitProvenance
}

/** Recursively find all .md files in a directory, skipping symlinks. */
export function globMarkdown(dir: string, base: string = ''): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.isSymbolicLink()) continue
    const rel = base ? join(base, entry.name) : entry.name
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...globMarkdown(full, rel))
    } else if (entry.name.endsWith('.md')) {
      results.push(rel.replace(/\\/g, '/'))
    }
  }
  return results.sort()
}

/**
 * Where a collection's bytes come from. The ONLY thing that differs between
 * content modes (KTD6): the working tree walks a folder, committed mode reads a
 * git commit, and everything downstream — the `.marginsignore` filter, the image
 * scan, the oversized report, the order and the hashing — is
 * {@link collectFromSource}, run once, shared.
 *
 * Reads are batch-shaped rather than per-path because the committed source runs
 * them as two `git cat-file --batch` processes (KTD12): one for markdown, one
 * for the images that markdown's content turns out to name. A per-path read
 * interface would force one process per file.
 */
export interface SyncFileSource {
  /**
   * Root the image scanner resolves markdown-relative references against. Paths
   * it returns are relative to this, `/`-separated.
   */
  scanRoot: string
  /**
   * Every candidate markdown path (sorted), plus the `.marginsignore` text that
   * governs THIS source — the committed source supplies the commit's copy, not
   * the working tree's.
   */
  list(): { mdPaths: string[]; ignoreText: string | null }
  /**
   * Phase one. Read every path given — these came from the source's own listing,
   * so a path it cannot supply is a bug in the source and it MUST throw rather
   * than return a short map. A silently short phase one is how a path bug turns
   * into an empty manifest, which the server's absent-path sweep reads as
   * "delete everything" (KTD10).
   */
  readMarkdown(paths: string[]): Map<string, Buffer>
  /**
   * Phase two. Read image candidates, OMITTING any the source cannot supply.
   * Unlike phase one these paths come from the image scanner, which deliberately
   * emits references that may not resolve; a stale image link must not abort the
   * collection (KTD12).
   */
  readImages(paths: string[]): Map<string, Buffer>
}

/**
 * The shared filter pipeline: one path, whatever the source.
 *
 * Filter markdown by `.marginsignore`, read it (phase one), scan the resulting
 * content for image references, read those (phase two), and emit the files in
 * glob order with each markdown file followed by the images it first referenced.
 */
export function collectFromSource(
  source: SyncFileSource,
  opts: { maxBlobSize?: number } = {},
): CollectedSyncFiles {
  const maxBlobSize = opts.maxBlobSize ?? MAX_BLOB_SIZE

  const { mdPaths: allMdFiles, ignoreText } = source.list()
  const ignoreFilter = buildIgnoreFilter(ignoreText)
  const mdFiles = allMdFiles.filter(ignoreFilter)

  // ─ Phase one: the markdown named by the listing. Fatal on a miss.
  const mdContents = source.readMarkdown(mdFiles)

  // Scan each markdown file for image references, in order. Candidates are
  // gathered up front so phase two can read them in ONE batch; per-markdown
  // reference order is kept so the emitted file order is unchanged.
  const refsByMd: string[][] = []
  const candidates: string[] = []
  const candidateSet = new Set<string>()
  for (const relPath of mdFiles) {
    const mdText = mdContents.get(relPath)!.toString('utf-8')
    const refs: string[] = []
    for (const imgPath of scanImagesInMarkdown(mdText, relPath, source.scanRoot)) {
      // Unsupported mime types are dropped before the read, as they always were.
      if (!mimeFromPath(imgPath)) continue
      refs.push(imgPath)
      if (!candidateSet.has(imgPath)) {
        candidateSet.add(imgPath)
        candidates.push(imgPath)
      }
    }
    refsByMd.push(refs)
  }

  // ─ Phase two: the images that content named. Skipped entirely when there are
  //   none — no process is spawned for a tree with no image references.
  const imgContents = candidates.length > 0
    ? source.readImages(candidates)
    : new Map<string, Buffer>()

  const files: SyncFile[] = []
  const seenPaths = new Set<string>()
  mdFiles.forEach((relPath, i) => {
    files.push({ path: relPath, content: mdContents.get(relPath)!, contentType: 'text/markdown' })
    seenPaths.add(relPath)
    for (const imgPath of refsByMd[i]!) {
      if (seenPaths.has(imgPath)) continue
      const content = imgContents.get(imgPath)
      if (content === undefined) continue   // absent or unreadable — skipped
      files.push({ path: imgPath, content, contentType: mimeFromPath(imgPath)! })
      seenPaths.add(imgPath)
    }
  })

  const oversized = files
    .filter(f => f.content.length > maxBlobSize)
    .map(f => ({ path: f.path, bytes: f.content.length }))

  return { files, mdCount: mdFiles.length, mdPaths: mdFiles, totalCount: files.length, oversized }
}

/** The working-tree file source: walk the folder, read off disk. */
export function workingTreeSource(dir: string): SyncFileSource {
  return {
    scanRoot: dir,
    list: () => ({ mdPaths: globMarkdown(dir), ignoreText: readIgnoreFileText(dir) }),
    // readFileSync throws on a path the walker just listed — the phase-one
    // fatal contract, satisfied by the filesystem itself.
    readMarkdown: (paths) =>
      new Map(paths.map((p) => [p, readFileSync(join(dir, p))] as const)),
    readImages: (paths) => {
      const out = new Map<string, Buffer>()
      for (const p of paths) {
        const full = join(dir, p)
        if (!existsSync(full)) continue
        try {
          out.set(p, readFileSync(full))
        } catch {
          // Skip unreadable images (e.g. a directory named like one → EISDIR)
        }
      }
      return out
    },
  }
}

/**
 * Collect all syncable files under `dir`: filtered markdown plus referenced
 * images. `maxBlobSize` is overridable for tests; defaults to the server cap.
 */
export function collectSyncFiles(
  dir: string,
  opts: { maxBlobSize?: number } = {},
): CollectedSyncFiles {
  return collectFromSource(workingTreeSource(dir), opts)
}

/**
 * Collector dispatch: the single place a mode chooses a file source.
 *
 * Everything downstream of the returned {@link CollectedSyncFiles} is one path,
 * by design (KTD6) — only the source differs. U5 replaces the committed arm's
 * stub with a real implementation and this dispatch does not change.
 */
export function collectForMode(
  dir: string,
  mode: ContentMode,
  opts: { maxBlobSize?: number; rev?: string } = {},
): CollectedSyncFiles {
  if (mode === 'committed') {
    return collectCommittedFiles(dir, opts)
  }
  return collectSyncFiles(dir, opts)
}

/** True when `dir` sits inside a git working tree. */
export function isInsideGitRepo(dir: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Cheap local probe, run BEFORE the network preflight so a wrong-directory run
 * fails locally and instantly instead of surfacing as a network error. It
 * replaces the empty-directory check that used to be the first thing a push
 * could fail on.
 *
 * It deliberately does NOT count files inside a git repository. It necessarily
 * runs before the mode is known, and in committed mode the filesystem is not the
 * source of truth: a pre-push syncs a ref the user is not standing on, and a
 * checkout whose markdown was removed without committing has the same shape on
 * disk. A file-counting probe would wrongly refuse both — the genuinely-empty
 * case is handled after the mode is settled, by the empty-collection contract
 * and the full-delete guard.
 *
 * Outside a git repository the reasoning inverts: committed mode is impossible
 * there (R15), so the filesystem IS the source of truth and a folder with no
 * markdown at all can only be a wrong directory.
 */
export function probeSyncSource(dir: string): void {
  if (!existsSync(dir)) {
    throw new ValidationError(`Directory does not exist: ${dir}`)
  }
  if (isInsideGitRepo(dir)) return
  if (globMarkdown(dir).length > 0) return
  throw new ValidationError(
    `No .md files found in ${dir}, and it is not inside a git repository — ` +
    'nothing was sent. Check the directory.',
  )
}

/**
 * Drop oversized blobs from a collected file set, reporting the skipped paths
 * on stderr. One >2 MB file must not 413-abort the whole push: the server
 * would reject the blob anyway, so it is excluded from the upload set AND
 * (since casSync derives the manifest from the files it receives) from the
 * manifest. Shared by `workspace push` and `sync`.
 */
export function skipOversized(collected: CollectedSyncFiles): SyncFile[] {
  const { files, oversized } = collected
  if (oversized.length === 0) return files
  process.stderr.write(
    `Warning: skipping ${oversized.length} file(s) over the ${MAX_BLOB_SIZE / (1024 * 1024)}MB server blob cap:\n` +
    oversized.map((f) => `  ${f.path} (${f.bytes} bytes)\n`).join(''),
  )
  const skip = new Set(oversized.map((f) => f.path))
  return files.filter((f) => !skip.has(f.path))
}
