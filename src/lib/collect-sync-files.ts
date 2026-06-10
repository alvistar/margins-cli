/**
 * Shared file-collection pipeline for CAS sync (push, sync, install/audit pre-checks).
 *
 * Globs markdown files (skipping dotdirs, node_modules, symlinks), applies the
 * `.marginsignore` filter, and collects referenced images (deduplicated; missing
 * refs and unsupported mime types skipped). Also reports blobs over the server's
 * MAX_BLOB_SIZE so install/audit can pre-check caps before opening PRs.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { scanImagesInMarkdown, mimeFromPath } from './image-scanner.js'
import { loadIgnoreFilter } from './marginsignore.js'

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

  return { files, mdCount: mdFiles.length, totalCount: files.length, oversized }
}
