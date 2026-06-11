/**
 * Repo-target resolution shared by `margins install` and `margins audit`:
 * normalize a single target (owner/repo or GitHub URL), or list an org's
 * repos and apply --include/--exclude glob filters.
 */
import { ValidationError } from './errors.js'
import { parseGithubUrl } from './detect-git-remote.js'
import * as gh from './gh.js'

// ─── Target normalization ─────────────────────────────────────────────────────

/** Normalize "owner/repo", https URL, or ssh remote to "owner/repo". */
export function normalizeTarget(target: string): string {
  const trimmed = target.trim()
  const parsed = parseGithubUrl(trimmed)
  if (parsed.type === 'github') return `${parsed.owner}/${parsed.repo}`
  // Bare owner/repo (optionally with a .git suffix) — not URL-shaped.
  const bare = trimmed.replace(/\.git$/, '')
  if (/^[^/\s]+\/[^/\s]+$/.test(bare)) return bare
  throw new ValidationError(`Invalid repository target: ${target} (expected owner/repo or a GitHub URL)`)
}

// ─── Glob filtering (--include / --exclude) ───────────────────────────────────

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/** Match against both the full name ("owner/repo") and the bare repo name. */
function matchesAny(fullName: string, globs: string[]): boolean {
  const short = fullName.split('/')[1] ?? fullName
  return globs.some((g) => {
    const re = globToRegex(g)
    return re.test(fullName) || re.test(short)
  })
}

export function filterRepos(repos: string[], include?: string[], exclude?: string[]): string[] {
  let result = repos
  if (include && include.length > 0) result = result.filter((r) => matchesAny(r, include))
  if (exclude && exclude.length > 0) result = result.filter((r) => !matchesAny(r, exclude))
  return result
}

// ─── Repo-list resolution ─────────────────────────────────────────────────────

export interface RepoTargetOpts {
  org?: string
  include?: string[]
  exclude?: string[]
}

/**
 * Resolve the repo list for a run: a single normalized target, or an org
 * listing with include/exclude filters applied. An empty result means no
 * repos matched the filters — callers report and bail.
 */
export async function resolveRepoTargets(
  target: string | undefined,
  opts: RepoTargetOpts,
): Promise<string[]> {
  if (!target && !opts.org) {
    throw new ValidationError('Specify a repo (owner/repo or GitHub URL) or --org <org>')
  }
  // Ambiguous: --org would silently win and write across the whole org.
  if (target && opts.org) {
    throw new ValidationError('Specify a repo OR --org, not both')
  }
  if (opts.org) {
    return filterRepos(await gh.listOrgRepos(opts.org), opts.include, opts.exclude)
  }
  return [normalizeTarget(target!)]
}
