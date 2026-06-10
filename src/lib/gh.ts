/**
 * Thin wrapper around the `gh` CLI (operator's ambient GitHub auth).
 *
 * All GitHub access from `margins install` / `margins audit` goes through
 * these functions — tests mock this module instead of child_process. Every
 * invocation uses execFile (argv array), never a shell-interpolated string.
 */
import { execFile } from 'node:child_process'

const MAX_BUFFER = 64 * 1024 * 1024

/** Typed error for failed gh invocations, carrying the HTTP status when parseable. */
export class GhError extends Error {
  constructor(
    message: string,
    /** HTTP status parsed from gh's error output (e.g. 403, 404, 422), if any. */
    public readonly status?: number,
    /** Seconds to wait, parsed from a rate-limit Retry-After hint, if any. */
    public readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'GhError'
  }
}

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const combined = `${stderr}\n${stdout}`
        const statusMatch = /HTTP (\d{3})/.exec(combined)
        const status = statusMatch ? Number(statusMatch[1]) : undefined
        const retryMatch = /retry[- ]after[:\s]+(\d+)/i.exec(combined)
        const retryAfter = retryMatch ? Number(retryMatch[1]) : undefined
        reject(new GhError(stderr.trim() || err.message, status, retryAfter))
        return
      }
      resolve(stdout)
    })
  })
}

async function ghApiJson(path: string, extraArgs: string[] = []): Promise<unknown> {
  const out = await runGh(['api', path, ...extraArgs])
  try {
    return JSON.parse(out)
  } catch {
    throw new GhError(`gh api ${path}: unparseable response`)
  }
}

// ─── Read operations ──────────────────────────────────────────────────────────

export interface RepoInfo {
  /** Immutable numeric repository id (binding anchor). */
  id: number
  /** Immutable numeric owner id (binding anchor). */
  ownerId: number
  /** "owner/repo" as GitHub reports it (canonical casing). */
  fullName: string
  defaultBranch: string
}

export async function getRepo(fullName: string): Promise<RepoInfo> {
  const data = await ghApiJson(`repos/${fullName}`) as {
    id: number
    owner: { id: number }
    full_name: string
    default_branch: string
  }
  return {
    id: data.id,
    ownerId: data.owner.id,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
  }
}

export interface TreeEntry {
  path: string
  /** Blob size in bytes (absent for tree entries). */
  size?: number
}

export interface RepoTree {
  entries: TreeEntry[]
  truncated: boolean
}

/** Shallow recursive file listing of a branch (blobs only). */
export async function listTree(fullName: string, branch: string): Promise<RepoTree> {
  const data = await ghApiJson(`repos/${fullName}/git/trees/${branch}?recursive=1`) as {
    tree: Array<{ path: string; type: string; size?: number }>
    truncated?: boolean
  }
  return {
    entries: data.tree
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path, size: e.size })),
    truncated: Boolean(data.truncated),
  }
}

/** List repo full names in an org (falls back to a user account on 404). */
export async function listOrgRepos(org: string): Promise<string[]> {
  let out: string
  try {
    out = await runGh(['api', `orgs/${org}/repos`, '--paginate', '--jq', '.[].full_name'])
  } catch (err) {
    if (err instanceof GhError && err.status === 404) {
      out = await runGh(['api', `users/${org}/repos`, '--paginate', '--jq', '.[].full_name'])
    } else {
      throw err
    }
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

/** Whether a file exists at `path` on `ref`. */
export async function fileExists(fullName: string, path: string, ref: string): Promise<boolean> {
  return (await getFileSha(fullName, path, ref)) !== null
}

/** Blob SHA of a file at `path` on `ref`, or null if absent. */
export async function getFileSha(fullName: string, path: string, ref: string): Promise<string | null> {
  try {
    const data = await ghApiJson(
      `repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    ) as { sha: string }
    return data.sha
  } catch (err) {
    if (err instanceof GhError && err.status === 404) return null
    throw err
  }
}

/** Decoded file content at `path` on `ref`, or null if absent. */
export async function getFileContent(
  fullName: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const data = await ghApiJson(
      `repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    ) as { content?: string }
    if (typeof data.content !== 'string') return null
    return Buffer.from(data.content, 'base64').toString('utf-8')
  } catch (err) {
    if (err instanceof GhError && err.status === 404) return null
    throw err
  }
}

/** Tag name of the latest published release, or null if the repo has none. */
export async function getLatestReleaseTag(fullName: string): Promise<string | null> {
  try {
    const data = await ghApiJson(`repos/${fullName}/releases/latest`) as { tag_name: string }
    return data.tag_name
  } catch (err) {
    if (err instanceof GhError && err.status === 404) return null
    throw err
  }
}

/** Tag names, in the order the API returns them (most recent first). */
export async function listTags(fullName: string): Promise<string[]> {
  const data = await ghApiJson(`repos/${fullName}/tags`) as Array<{ name: string }>
  return data.map((t) => t.name)
}

/** SHA a tag ref points at (commit, or tag object for annotated tags); null if absent. */
export async function getTagSha(fullName: string, tag: string): Promise<string | null> {
  try {
    const data = await ghApiJson(
      `repos/${fullName}/git/ref/${encodeURIComponent(`tags/${tag}`)}`,
    ) as { object: { sha: string } }
    return data.object.sha
  } catch (err) {
    if (err instanceof GhError && err.status === 404) return null
    throw err
  }
}

/** Commit SHA a branch points at. */
export async function getBranchSha(fullName: string, branch: string): Promise<string> {
  const data = await ghApiJson(
    `repos/${fullName}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
  ) as { object: { sha: string } }
  return data.object.sha
}

export async function branchExists(fullName: string, branch: string): Promise<boolean> {
  try {
    await getBranchSha(fullName, branch)
    return true
  } catch (err) {
    if (err instanceof GhError && err.status === 404) return false
    throw err
  }
}

// ─── Write operations ─────────────────────────────────────────────────────────

export async function createBranch(fullName: string, branch: string, sha: string): Promise<void> {
  await ghApiJson(`repos/${fullName}/git/refs`, [
    '-X', 'POST',
    '-f', `ref=refs/heads/${branch}`,
    '-f', `sha=${sha}`,
  ])
}

/** Create or update a file on a branch (contents API). */
export async function putFile(
  fullName: string,
  opts: { path: string; branch: string; message: string; contentBase64: string; sha?: string },
): Promise<void> {
  const args = [
    '-X', 'PUT',
    '-f', `message=${opts.message}`,
    '-f', `content=${opts.contentBase64}`,
    '-f', `branch=${opts.branch}`,
  ]
  if (opts.sha) args.push('-f', `sha=${opts.sha}`)
  await ghApiJson(`repos/${fullName}/contents/${opts.path}`, args)
}

export async function createPullRequest(
  fullName: string,
  opts: { title: string; head: string; base: string; body: string },
): Promise<{ url: string }> {
  const data = await ghApiJson(`repos/${fullName}/pulls`, [
    '-X', 'POST',
    '-f', `title=${opts.title}`,
    '-f', `head=${opts.head}`,
    '-f', `base=${opts.base}`,
    '-f', `body=${opts.body}`,
  ]) as { html_url: string }
  return { url: data.html_url }
}
