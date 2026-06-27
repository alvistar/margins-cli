import { createHash } from 'node:crypto'
import type { ApiClient } from './api-client.js'
import {
  ConflictError, MergeConflictError, ServerError, ValidationError,
  FullDeleteNotConfirmedError,
  type SyncConflictEntry,
} from './errors.js'
import { poolMap } from './pool.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CasSyncResult {
  added: number
  changed: number
  deleted: number
  uploaded: number   // blobs actually transferred
  skipped: number    // blobs already on server
  merged: boolean    // server 3-way-merged this push with a concurrent edit
}

interface ManifestResponse {
  files: Record<string, string>  // path → sha256 hash
  headSha: string | null
}

interface SyncFile {
  path: string
  content: Buffer
  contentType: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Compute a deterministic synthetic commit SHA from a path→hash manifest:
 * sha256 over sorted entries of `path\thash\n` (sorted by path, plain byte
 * order). Byte-identical to the desktop implementation
 * (margins-desktop src-tauri/src/sync/cas_sync.rs `synthetic_commit_sha`) —
 * the shared test vector lives in `__tests__/fixtures/synthetic-sha-vector.json`.
 *
 * Same input manifest → same SHA, so retries produce the same value and the
 * server's headSha-match idempotency path (D-019) short-circuits cleanly.
 * Output is a 64-char lowercase hex string satisfying ManifestPushSchema's
 * `^[a-f0-9]{64}$` validation.
 */
export function syntheticCommitSha(manifest: Record<string, string>): string {
  const paths = Object.keys(manifest)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8')))
  let buf = ''
  for (const path of paths) {
    buf += `${path}\t${manifest[path]}\n`
  }
  return sha256(Buffer.from(buf, 'utf-8'))
}

/** Map a 422 PUSH_SYNC_NOT_SUPPORTED server error to an actionable message. */
function mapSyncError(err: unknown): never {
  if (err instanceof ServerError && err.code === 'PUSH_SYNC_NOT_SUPPORTED') {
    throw new ValidationError(
      "This workspace does not support client push sync (its syncMode is not 'client'). " +
      'Server-managed workspaces sync via GitHub — use `margins workspace sync` instead, ' +
      'or recreate the workspace with client sync enabled.',
    )
  }
  throw err
}

/** Server counts from a clean auto-merge (`200 { merged: true, ... }`). */
interface ServerMergeCounts {
  added: number
  changed: number
  deleted: number
}

/**
 * Detect a clean server-side auto-merge from a manifest POST response. The
 * server returns `{ merged: true, added, changed, deleted, head, files }` when
 * it merged this push with a concurrent edit; a plain fast-forward omits
 * `merged`. Returns the server's merge counts, or null for a fast-forward.
 */
function parseMergeResult(resp: unknown): ServerMergeCounts | null {
  if (!resp || typeof resp !== 'object') return null
  if ((resp as { merged?: unknown }).merged !== true) return null
  const r = resp as { added?: unknown; changed?: unknown; deleted?: unknown }
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return { added: n(r.added), changed: n(r.changed), deleted: n(r.deleted) }
}

/**
 * Build the user-facing message for a server-side merge conflict: name the
 * conflicting file(s) and the reconcile next step. A whole-tree conflict
 * (path `"*"`, e.g. an unreconstructable base) gets a generic phrasing.
 */
function formatMergeConflictMessage(conflicts: SyncConflictEntry[]): string {
  const next = 'Pull the latest, reconcile, and push again.'
  const paths = conflicts.map((c) => c.path).filter((p) => p !== '*')
  if (paths.length === 0) {
    return `Your push conflicts with a newer change and was not applied. ${next}`
  }
  const verb = paths.length === 1 ? 'conflicts' : 'conflict'
  return `${paths.join(', ')} ${verb} with a newer change — your push did not land. ${next}`
}

// ─── CAS sync ────────────────────────────────────────────────────────────────

const UPLOAD_CONCURRENCY = 5

/**
 * Content-addressable sync protocol.
 *
 * 1. Fetch the server manifest for the branch
 * 2. Compute SHA-256 of each local file, diff against manifest
 * 3. Upload new/changed blobs (up to 5 concurrent)
 * 4. Commit the new manifest with a synthetic commitSha (derived from the
 *    local manifest, see {@link syntheticCommitSha}) and parentSha = the
 *    server's headSha from step 1. SHAs are computed here — callers never
 *    supply them (git SHAs are the wrong shape AND the wrong semantics).
 *
 * On ANY 409 the push surfaces-and-stops — it is NEVER re-pushed. Post-PR2 the
 * server 3-way-merges a divergent push, so a 409 is always a real content
 * conflict (SYNC_MERGE_CONFLICT); re-pushing would clobber the writer the
 * server preserved. An unrecognized 409 is treated the same way (a hard
 * conflict to reconcile), never an overwrite. The CLI writes no local files,
 * so the user's working copy is preserved.
 */
export interface CasSyncOptions {
  /**
   * Allow a push that would delete every file on the branch. Without it, such a
   * push is refused locally (nothing destructive is sent) and the server's
   * matching guard (`SYNC_FULL_DELETE_NOT_CONFIRMED`) is a backstop.
   */
  confirmFullDelete?: boolean
}

export async function casSync(
  client: ApiClient,
  workspaceId: string,
  branch: string,
  files: SyncFile[],
  opts: CasSyncOptions = {},
): Promise<CasSyncResult> {
  const basePath = `/api/workspaces/${workspaceId}/sync`

  // Step 1: Fetch current server manifest
  const manifest = await client.get(
    `${basePath}/manifest`,
    { branch },
  ).catch(mapSyncError) as ManifestResponse

  const serverFiles = manifest.files ?? {}

  // Step 2: Compute local hashes and diff
  const localFiles: Record<string, string> = {}
  const localByHash = new Map<string, SyncFile>()

  for (const file of files) {
    const hash = sha256(file.content)
    localFiles[file.path] = hash
    localByHash.set(hash, file)
  }

  // Guard: a push that empties a populated branch is almost always an accident
  // (wrong cwd, a removed working tree). Refuse it locally — uploading nothing,
  // committing nothing — unless the caller explicitly confirmed. Mirrors the
  // server's SYNC_FULL_DELETE_NOT_CONFIRMED guard so behaviour is identical
  // whether or not the server is reached.
  const wouldEmptyBranch =
    Object.keys(serverFiles).length > 0 && Object.keys(localFiles).length === 0
  if (wouldEmptyBranch && !opts.confirmFullDelete) {
    throw FullDeleteNotConfirmedError.forBranch(branch, Object.keys(serverFiles).length)
  }

  // Determine what changed
  let added = 0
  let changed = 0
  const deleted = Object.keys(serverFiles).filter(p => !(p in localFiles)).length

  // Collect hashes that need uploading (new or changed content)
  const hashesOnServer = new Set(Object.values(serverFiles))
  const hashesToUpload = new Set<string>()

  for (const [filePath, hash] of Object.entries(localFiles)) {
    const serverHash = serverFiles[filePath]
    if (serverHash === undefined) {
      added++
      if (!hashesOnServer.has(hash)) {
        hashesToUpload.add(hash)
      }
    } else if (serverHash !== hash) {
      changed++
      if (!hashesOnServer.has(hash)) {
        hashesToUpload.add(hash)
      }
    }
  }

  // Step 3: Upload blobs concurrently
  const toUpload = [...hashesToUpload]

  await poolMap(toUpload, UPLOAD_CONCURRENCY, async (hash) => {
    const file = localByHash.get(hash)!
    await client.putRaw(
      `${basePath}/objects/${hash}`,
      file.content,
      file.contentType,
    )
  })

  const uploaded = toUpload.length

  // Step 4: Commit the new manifest. commitSha is synthetic and derived from
  // localFiles; parentSha is the server's headSha (CAS swap contract). The
  // response carries the clean-auto-merge signal (`merged: true` + the server's
  // merge counts); a plain fast-forward returns just `{ added, changed, deleted }`.
  const commitSha = syntheticCommitSha(localFiles)
  let postResp: unknown
  try {
    postResp = await client.post(`${basePath}/manifest`, {
      branch,
      commitSha,
      parentSha: manifest.headSha,
      files: localFiles,
      ...(opts.confirmFullDelete ? { confirmFullDelete: true } : {}),
    })
  } catch (err) {
    // A server-side merge conflict: name the conflicting files + next step and
    // STOP. (R1/R2/R3, KTD2)
    if (err instanceof MergeConflictError) {
      throw new MergeConflictError(
        err.conflicts, err.head, formatMergeConflictMessage(err.conflicts),
      )
    }
    // ANY other 409 also surfaces-and-stops — we NEVER refetch-and-repush
    // (that would clobber a concurrent writer). Post-PR2 the server only emits
    // SYNC_MERGE_CONFLICT for a 409; an unrecognized 409 is still a conflict the
    // user must reconcile, not an overwrite.
    if (err instanceof ConflictError) {
      throw new ConflictError(
        'Your push conflicted with the server and was not applied. ' +
        'Pull the latest, reconcile, and push again.',
      )
    }
    mapSyncError(err)
  }

  // Clean auto-merge (R4, KTD3): the server merged this push with a concurrent
  // edit. The CLI is push-only — it never writes document content (the working
  // copy is the user's own git repo) — so we cannot apply the merged tree. We
  // report the server's merge counts (not the local diff) and advise the user
  // their copy is behind. `skipped`/`uploaded` stay local — they describe blob
  // transfer, not the merge.
  const merge = parseMergeResult(postResp)
  if (merge) {
    process.stderr.write(
      `[margins] Your push was auto-merged with a concurrent edit on the server ` +
      `(${merge.added} added, ${merge.changed} changed, ${merge.deleted} deleted). ` +
      `Your local copy is now behind the merged result — pull / re-sync the latest ` +
      `before editing again.\n`,
    )
  }

  return {
    added: merge ? merge.added : added,
    changed: merge ? merge.changed : changed,
    deleted: merge ? merge.deleted : deleted,
    uploaded,
    skipped: files.length - added - changed,
    merged: merge !== null,
  }
}
