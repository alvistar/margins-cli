/**
 * Git remote detection — ported from Rust margins-desktop/src-tauri/src/workspace/detect.rs
 */
import { execSync } from 'node:child_process'

export type GitRemote =
  | { type: 'github'; owner: string; repo: string }
  | { type: 'other'; url: string }
  | { type: 'none' }

/** Detect the git remote for a directory by running `git remote get-url origin`. */
export function detectGitRemote(dir: string): GitRemote {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()

    if (!url) return { type: 'none' }
    return parseGithubUrl(url)
  } catch {
    return { type: 'none' }
  }
}

/**
 * Parse a URL into a GitRemote.
 *
 * Handles:
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 */
export function parseGithubUrl(url: string): GitRemote {
  // SSH format: git@github.com:owner/repo.git
  if (url.startsWith('git@github.com:')) {
    const rest = url.slice('git@github.com:'.length).replace(/\.git$/, '')
    const [owner, repo] = rest.split('/')
    if (owner && repo) {
      return { type: 'github', owner, repo: repo.split('/')[0] }
    }
  }

  // HTTPS or SSH URL format with github.com
  if (url.includes('github.com')) {
    const prefixes = [
      'https://github.com/',
      'http://github.com/',
      'ssh://git@github.com/',
    ]
    for (const prefix of prefixes) {
      if (url.startsWith(prefix)) {
        const path = url.slice(prefix.length).replace(/\.git$/, '')
        const [owner, repo] = path.split('/')
        if (owner && repo) {
          return { type: 'github', owner, repo: repo.split('/')[0] }
        }
      }
    }
  }

  return url ? { type: 'other', url } : { type: 'none' }
}

/**
 * Sanitize a folder name for use as a Margins project name.
 * Rules: lowercase, only [a-z0-9._-], max 64 chars, no leading/trailing dashes.
 */
export function sanitizeProjectName(name: string): string {
  let sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')  // collapse multiple dashes
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
    .slice(0, 64)

  return sanitized || 'workspace'
}
