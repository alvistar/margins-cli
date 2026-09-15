import { readFileSync, lstatSync } from 'node:fs'
import { resolve, relative, isAbsolute, extname } from 'node:path'
import { mimeFromPath } from './image-scanner.js'

// ─── Inlining a design's local assets ─────────────────────────────────────────
//
// Margins stores an HTML stash SANITIZED, and the sanitizer drops every external
// reference: `<link rel="stylesheet">`, `<img src="css/…">`, web fonts, anything
// loaded from a URL. A design uploaded as authored therefore arrives with no
// styling and no images, and the author has no way to tell that from a design
// that was wrong to begin with.
//
// So the CLI folds the local ones in before the upload: a stylesheet becomes a
// `<style>` block, an image becomes a `data:` URI. The result is the one
// self-contained file the server can keep.
//
//   <link rel=stylesheet href="css/site.css">  ─►  <style>…the file's bytes…</style>
//   <img src="img/logo.png">                   ─►  <img src="data:image/png;base64,…">
//
// Tag-attribute regexes, not a parser: this CLI ships with zero runtime
// dependencies and adding an HTML parser to inline two attributes would end that.
// The cost is accepted because the SERVER parses properly and has the last word —
// anything this misreads is dropped there, not rendered.
//
// ── Two rules that are about safety, not fidelity ──
//
// 1. ALLOW-LIST, never deny-list. A reference is read only when its extension is
//    `.css` or maps to a known image MIME type. Without that, a crafted page in a
//    directory the user stashes from (`<img src=".env">`, `<link
//    href="secrets.json">`) would have its contents base64'd into a document
//    about to be published. A deny-list cannot be made complete; this can.
//
// 2. Never follow a reference out of the directory, and never follow a symlink.
//    `../../../etc/passwd` and a symlink pointing there are the same attack with
//    two spellings.
//
// And one rule about correctness: matches inside `<!-- -->`, `<script>` and
// `<style>` are SKIPPED. A commented-out `<img>` is not part of the document, and
// inlining it both wastes the size budget and reads a file the page does not use.

export interface InlinedAsset {
  /** The reference as written in the document. */
  path: string
  /** Bytes read from disk (not the base64 length). */
  bytes: number
}

export interface InlineResult {
  html: string
  /** Every asset folded in, in document order. Printed for the user. */
  inlined: InlinedAsset[]
  /** References deliberately left alone, each with the reason. */
  warnings: string[]
}

/** Extensions that may be read as a stylesheet. */
const STYLESHEET_EXTENSIONS = new Set(['.css'])

/**
 * A reference Margins should not touch: it is not a local file path.
 *
 * `//cdn.example.com/x.css` is protocol-relative and remote; a bare `#anchor` is
 * a fragment; anything with a `scheme:` prefix is a URL. `data:` is already
 * inlined.
 */
function isRemoteOrNonFile(ref: string): boolean {
  return ref.startsWith('//') || ref.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(ref)
}

/** Strip a `?query` and `#fragment` — they address the server, not the disk. */
function toDiskPath(ref: string): string {
  return ref.split('#')[0]!.split('?')[0]!
}

type ReadOutcome =
  | { ok: true; buffer: Buffer; diskPath: string }
  | { ok: false; warning: string }

/**
 * Read a referenced file, or say why not.
 *
 * Every refusal is a WARNING and leaves the tag untouched rather than failing the
 * stash. A design with one missing image is still worth reviewing, and the author
 * can see from the warning which one it was — where a hard failure would tell
 * them only that something, somewhere, was wrong.
 */
function readAsset(ref: string, baseDir: string, allowed: (p: string) => boolean): ReadOutcome {
  const diskPath = toDiskPath(ref)
  if (!diskPath) return { ok: false, warning: `${ref} — empty reference, left as is` }

  // An absolute path is not relative to the document, so it is not the
  // document's asset. Treated like a remote reference.
  if (isAbsolute(diskPath)) {
    return { ok: false, warning: `${ref} — absolute path, left as is` }
  }

  if (!allowed(diskPath)) {
    return {
      ok: false,
      warning: `${ref} — not a stylesheet or a known image type, left as is (Margins never reads a file kind it cannot render)`,
    }
  }

  const abs = resolve(baseDir, diskPath)
  const rel = relative(baseDir, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, warning: `${ref} — outside the document's folder, left as is` }
  }

  // lstat, not stat: a symlink must be refused, not followed to whatever it
  // points at. Checked before the read, so the read never happens.
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      return { ok: false, warning: `${ref} — a symlink, left as is` }
    }
  } catch {
    return { ok: false, warning: `${ref} — not found, left as is` }
  }

  try {
    return { ok: true, buffer: readFileSync(abs), diskPath }
  } catch {
    return { ok: false, warning: `${ref} — could not be read, left as is` }
  }
}

/**
 * Blank out the ranges a reference inside must NOT be inlined from.
 *
 * Returns a string of the same LENGTH as the input, with comment, script and
 * style bodies replaced by spaces. Same length is the whole point: every index
 * found in the mask addresses the same character in the original, so the
 * replacements below can splice into the real document.
 */
function maskInertRegions(html: string): string {
  const chars = html.split('')
  const blank = (start: number, end: number) => {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }

  for (const re of [
    /<!--[\s\S]*?-->/g,
    /<script\b[\s\S]*?<\/script\s*>/gi,
    /<style\b[\s\S]*?<\/style\s*>/gi,
  ]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) blank(m.index, m.index + m[0].length)
  }

  // An unterminated <script> or <!-- swallows the rest of the document in a
  // browser too, so everything after it is inert and must not be scanned.
  const unterminated = (open: RegExp, close: RegExp): void => {
    open.lastIndex = 0
    const o = open.exec(html)
    if (!o) return
    close.lastIndex = o.index + o[0].length
    if (close.exec(html)) return
    blank(o.index, html.length)
  }
  unterminated(/<script\b/gi, /<\/script\s*>/gi)
  unterminated(/<!--/g, /-->/g)

  return chars.join('')
}

/** Read one attribute's value and its index inside a tag, or null. */
function attr(tag: string, name: string): { value: string; start: number; end: number } | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const m = re.exec(tag)
  if (!m) return null
  const quoted = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]
  if (quoted === undefined) return null
  const valueOffset = m.index + m[0].length - m[1]!.length + (m[4] === undefined ? 1 : 0)
  return { value: quoted, start: valueOffset, end: valueOffset + quoted.length }
}

/**
 * A `</style>` inside the CSS would close the block we just opened, so the
 * browser would render the rest of the stylesheet as text. CSS reads `<\/style>`
 * as the same characters.
 */
function escapeForStyleBlock(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1')
}

interface Edit {
  start: number
  end: number
  replacement: string
}

/**
 * Fold a document's local stylesheets and images into the document itself.
 *
 * Pure apart from reading the referenced files: it takes the HTML and a base
 * directory and returns new HTML, so the caller decides what to print and
 * whether the result is small enough to upload.
 */
export function inlineLocalAssets(html: string, baseDir: string): InlineResult {
  const masked = maskInertRegions(html)
  const inlined: InlinedAsset[] = []
  const warnings: string[] = []
  const edits: Edit[] = []

  const tagRe = /<(link|img|image)\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(masked)) !== null) {
    const tagStart = match.index
    const tag = html.slice(tagStart, tagStart + match[0].length)
    const kind = match[1]!.toLowerCase()

    if (kind === 'link') {
      const rel = attr(tag, 'rel')
      if (!rel || !/\bstylesheet\b/i.test(rel.value)) continue
      const href = attr(tag, 'href')
      if (!href || isRemoteOrNonFile(href.value)) continue

      const read = readAsset(href.value, baseDir, (p) =>
        STYLESHEET_EXTENSIONS.has(extname(p).toLowerCase()),
      )
      if (!read.ok) {
        warnings.push(read.warning)
        continue
      }
      inlined.push({ path: href.value, bytes: read.buffer.byteLength })
      edits.push({
        start: tagStart,
        end: tagStart + tag.length,
        replacement: `<style>\n${escapeForStyleBlock(read.buffer.toString('utf-8'))}\n</style>`,
      })
      continue
    }

    // <img src> and inline SVG's <image href> / <image xlink:href>.
    const src = attr(tag, 'src') ?? attr(tag, 'href') ?? attr(tag, 'xlink:href')
    if (!src || isRemoteOrNonFile(src.value)) continue

    const read = readAsset(src.value, baseDir, (p) => mimeFromPath(p) !== null)
    if (!read.ok) {
      warnings.push(read.warning)
      continue
    }
    const mime = mimeFromPath(read.diskPath)!
    inlined.push({ path: src.value, bytes: read.buffer.byteLength })
    edits.push({
      start: tagStart + src.start,
      end: tagStart + src.end,
      replacement: `data:${mime};base64,${read.buffer.toString('base64')}`,
    })
  }

  // Back to front, so an earlier edit's replacement cannot shift a later one's
  // indices out from under it.
  let out = html
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
  }

  return { html: out, inlined, warnings }
}

/** Human-readable byte size for the inlined list and the over-cap refusal. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
