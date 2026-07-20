/**
 * .marginsignore support — gitignore-compatible file filtering.
 *
 * Loads default ignore patterns (node_modules, .git, dotfiles) plus any
 * patterns from a `.marginsignore` file in the repo root. Returns a filter
 * function that returns true for files that should be INCLUDED (not ignored).
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Default patterns always applied (gitignore syntax). */
const DEFAULT_PATTERNS = [
  'node_modules/',
  '.git/',
  '.*',         // dotfiles and dot-directories
]

interface CompiledPattern {
  regex: RegExp
  negated: boolean
}

/**
 * Convert a single gitignore pattern to a RegExp.
 *
 * Supports:
 *   - `*` matches anything except `/`
 *   - `**` matches everything including `/`
 *   - `?` matches any single char except `/`
 *   - Trailing `/` matches directories (we treat as prefix match)
 *   - Leading `!` negates the pattern
 *   - Leading `/` anchors to root (otherwise matches anywhere)
 *   - `#` lines and blank lines are skipped (handled by caller)
 */
function compilePattern(raw: string): CompiledPattern | null {
  let pattern = raw.trim()
  if (!pattern || pattern.startsWith('#')) return null

  let negated = false
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }

  // Leading backslash escapes the next char (e.g. \# to match literal #)
  if (pattern.startsWith('\\')) {
    pattern = pattern.slice(1)
  }

  // Track whether pattern is anchored to root
  let anchored = false
  if (pattern.startsWith('/')) {
    anchored = true
    pattern = pattern.slice(1)
  }

  // Trailing slash means "directory only" — for our purposes, match as prefix
  const dirOnly = pattern.endsWith('/')
  if (dirOnly) {
    pattern = pattern.slice(0, -1)
  }

  // If pattern contains a slash (other than leading/trailing), it's anchored
  if (pattern.includes('/')) {
    anchored = true
  }

  // Escape regex special chars, then convert glob wildcards
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials
    .replace(/\*\*/g, '\0DOUBLESTAR\0')     // placeholder for **
    .replace(/\*/g, '[^/]*')                 // * = anything except /
    .replace(/\?/g, '[^/]')                  // ? = single char except /
    .replace(/\0DOUBLESTAR\0/g, '.*')        // ** = anything including /

  if (dirOnly) {
    // Match the directory itself or anything under it
    regexStr = anchored
      ? `^${regexStr}(?:/|$)`
      : `(?:^|/)${regexStr}(?:/|$)`
  } else if (anchored) {
    regexStr = `^${regexStr}(?:$|/)`
  } else {
    // Unanchored: match basename or any path segment
    regexStr = `(?:^|/)${regexStr}(?:$|/)`
  }

  return { regex: new RegExp(regexStr), negated }
}

/** Read `.marginsignore` from a directory on disk. `null` when there is none. */
export function readIgnoreFileText(repoRoot: string): string | null {
  const ignorePath = join(repoRoot, '.marginsignore')
  if (!existsSync(ignorePath)) return null
  return readFileSync(ignorePath, 'utf-8')
}

/**
 * Build the ignore predicate from already-read `.marginsignore` text (`null`
 * when the source has none), combined with the built-in defaults. Returns a
 * predicate that returns `true` for files that should be INCLUDED (i.e. not
 * ignored).
 *
 * Taking TEXT rather than a directory is what lets committed-mode collection
 * filter a commit by the `.marginsignore` stored IN that commit instead of by
 * whatever happens to be checked out — while both sources still share one
 * pattern compiler, so the defaults cannot diverge between them (KTD6).
 */
export function buildIgnoreFilter(ignoreText: string | null): (filePath: string) => boolean {
  const patterns: CompiledPattern[] = []

  // Compile default patterns
  for (const raw of DEFAULT_PATTERNS) {
    const compiled = compilePattern(raw)
    if (compiled) patterns.push(compiled)
  }

  if (ignoreText !== null) {
    for (const line of ignoreText.split('\n')) {
      const compiled = compilePattern(line)
      if (compiled) patterns.push(compiled)
    }
  }

  return (filePath: string): boolean => {
    // Normalize to forward slashes
    const normalized = filePath.replace(/\\/g, '/')

    // Last matching pattern wins (gitignore semantics)
    let ignored = false
    for (const { regex, negated } of patterns) {
      // Test against the full path and also prepend "/" so anchored patterns
      // and basename patterns both work against relative paths.
      if (regex.test(normalized) || regex.test('/' + normalized)) {
        ignored = !negated
      }
    }

    return !ignored
  }
}
