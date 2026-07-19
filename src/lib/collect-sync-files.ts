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
import { loadIgnoreFilter } from './marginsignore.js'
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
 * Collect all syncable files under `dir`: filtered markdown plus referenced
 * images. `maxBlobSize` is overridable for tests; defaults to the server cap.
 */
export function collectSyncFiles(
  dir: string,
  opts: { maxBlobSize?: number } = {},
): CollectedSyncFiles {
  const maxBlobSize = opts.maxBlobSize ?? MAX_BLOB_SIZE

  const allMdFiles = globMarkdown(dir)
  const ignoreFilter = loadIgnoreFilter(dir)
  const mdFiles = allMdFiles.filter(ignoreFilter)

  const files: SyncFile[] = []
  const seenPaths = new Set<string>()

  for (const relPath of mdFiles) {
    const content = readFileSync(join(dir, relPath))
    files.push({ path: relPath, content, contentType: 'text/markdown' })
    seenPaths.add(relPath)

    // Scan for image references
    const mdText = content.toString('utf-8')
    const imagePaths = scanImagesInMarkdown(mdText, relPath, dir)
    for (const imgPath of imagePaths) {
      if (seenPaths.has(imgPath)) continue
      const imgFull = join(dir, imgPath)
      if (!existsSync(imgFull)) continue
      const mime = mimeFromPath(imgPath)
      if (!mime) continue
      try {
        files.push({ path: imgPath, content: readFileSync(imgFull), contentType: mime })
        seenPaths.add(imgPath)
      } catch {
        // Skip unreadable images
      }
    }
  }

  const oversized = files
    .filter(f => f.content.length > maxBlobSize)
    .map(f => ({ path: f.path, bytes: f.content.length }))

  return { files, mdCount: mdFiles.length, mdPaths: mdFiles, totalCount: files.length, oversized }
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
