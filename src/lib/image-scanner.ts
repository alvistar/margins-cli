import { resolve, dirname, relative, sep } from 'node:path'
import { lstatSync } from 'node:fs'

export interface ScannedFile {
  path: string        // relative path from repo root
  content: Buffer     // file content
  contentType: string // MIME type
}

// ─── MIME type lookup ────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
}

export function mimeFromPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return null
  return MIME_TYPES[filePath.slice(dot).toLowerCase()] ?? null
}

// ─── Markdown image scanner ─────────────────────────────────────────────────

/**
 * Extract image paths referenced in a markdown file.
 *
 * Matches:
 *   - ![alt](path)              — standard markdown images
 *   - ![alt](path "title")      — markdown images with title
 *   - <img src="path" ...>      — HTML img tags (single or double quotes)
 *
 * Skips:
 *   - Remote URLs (http://, https://, data:)
 *   - Paths that resolve outside repoRoot
 *   - Symlinks
 *
 * Returns deduplicated list of image paths relative to repoRoot.
 */
export function scanImagesInMarkdown(
  mdContent: string,
  mdFilePath: string,
  repoRoot: string,
): string[] {
  const mdDir = dirname(resolve(repoRoot, mdFilePath))
  const resolvedRoot = resolve(repoRoot)
  const seen = new Set<string>()
  const results: string[] = []

  // Pattern 1: ![alt](path) or ![alt](path "title")
  const mdImageRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  // Pattern 2: <img ... src="path" ...> or <img ... src='path' ...>
  const htmlImgRe = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi

  const rawPaths: string[] = []

  let match: RegExpExecArray | null
  while ((match = mdImageRe.exec(mdContent)) !== null) {
    rawPaths.push(match[1]!)
  }
  while ((match = htmlImgRe.exec(mdContent)) !== null) {
    rawPaths.push(match[1]!)
  }

  for (const raw of rawPaths) {
    // Skip remote URLs and data URIs
    if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) continue

    // Decode percent-encoded paths (e.g. %20 -> space)
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      decoded = raw
    }

    // Resolve relative to the markdown file's directory
    const abs = resolve(mdDir, decoded)

    // Reject paths outside repoRoot
    const relFromRoot = relative(resolvedRoot, abs)
    if (relFromRoot.startsWith('..') || relFromRoot.startsWith(sep + sep)) continue

    // Skip symlinks
    try {
      const stat = lstatSync(abs)
      if (stat.isSymbolicLink()) continue
    } catch {
      // File doesn't exist — still include the path; caller decides what to do
      // (the read step will fail gracefully)
    }

    // Normalize to forward slashes
    const normalized = relFromRoot.replace(/\\/g, '/')

    // Deduplicate
    if (!seen.has(normalized)) {
      seen.add(normalized)
      results.push(normalized)
    }
  }

  return results
}
