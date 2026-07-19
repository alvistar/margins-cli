import { createHash } from 'node:crypto'
import type { ApiClient } from './api-client.js'
import {
  ConflictError, MergeConflictError, ServerError, ValidationError,
  FullDeleteNotConfirmedError,
  type SyncConflictEntry,
} from './errors.js'
import { poolMap } from './pool.js'
import type { GitProvenance } from './collect-sync-files.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CasSyncResult {
  added: number
  changed: number
  deleted: number
  uploaded: number   // blobs actually transferred
  skipped: number    // blobs already on server
  merged: boolean    // server 3-way-merged this push with a concurrent edit
}

/**
 * What a sync sends: the working tree as it sits on disk, or the content of a
 * git commit. A per-workspace setting, never cached locally — it is delivered by
 * the preflight on every push (KTD1).
 */
export type ContentMode = 'working-tree' | 'committed'

/**
 * The header both write routes read to learn what the client actually collected
 * under. Mirrors the `X-Margins-Client` convention. Sent on the manifest POST
 * and on every blob PUT; never on the read-only preflight.
 */
export const CONTENT_MODE_HEADER = 'X-Margins-Content-Mode'

export function isContentMode(value: unknown): value is ContentMode {
  return value === 'working-tree' || value === 'committed'
}

/**
 * The sync preflight: the server's current manifest for a branch, plus the
 * workspace's content mode.
 *
 * `contentMode` ABSENT is the capability signal (KTD2), and the only one there
 * is: a server that has deployed content modes reports the mode unconditionally
 * — a workspace with none stored reports `"working-tree"` explicitly. So a
 * missing field means the server predates the feature, and since a plain zod
 * object silently strips unknown keys, a mode declared to such a server would be
 * dropped and the push would apply unenforced.
 */
export interface SyncPreflight {
  files: Record<string, string>  // path → sha256 hash
  headSha: string | null
  contentMode?: ContentMode
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

/**
 * Map a 422 PUSH_SYNC_NOT_SUPPORTED server error to an actionable message.
 *
 * ONE owner: both the preflight GET ({@link fetchSyncPreflight}) and the
 * manifest POST inside {@link casSync} route their failures through here. The
 * GET moved out of `casSync` in U4, and the mapping deliberately did not get
 * copied along with it — two homes for one message is how they drift apart.
 */
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

// ─── Preflight: settle the mode before anything is collected (KTD3) ──────────

export function syncBasePath(workspaceId: string): string {
  return `/api/workspaces/${workspaceId}/sync`
}

/**
 * Fetch the sync preflight for a branch. Lifted OUT of {@link casSync} in U4 so
 * the workspace's content mode is known BEFORE collection: the client uploads
 * blobs before it posts the manifest, so enforcing at the manifest post would
 * mean a stale client uploads gitignored bytes and is refused afterwards — the
 * private-file leak this feature exists to close, reproduced inside the fix.
 *
 * A present-but-unrecognised mode is a hard failure, never a silent
 * working-tree default: the column carries no database CHECK constraint, so an
 * out-of-range value is reachable, and guessing at it is exactly the fail-open
 * this design refuses.
 */
export async function fetchSyncPreflight(
  client: ApiClient,
  workspaceId: string,
  branch: string,
): Promise<SyncPreflight> {
  const resp = await client.get(
    `${syncBasePath(workspaceId)}/manifest`,
    { branch },
  ).catch(mapSyncError) as {
    files?: Record<string, string>
    headSha?: string | null
    contentMode?: unknown
  } | null

  const raw = resp?.contentMode
  if (raw !== undefined && raw !== null && !isContentMode(raw)) {
    throw new ValidationError(
      `The server reported an unrecognised content mode (${JSON.stringify(raw)}) for this ` +
      'workspace, so nothing was sent. Upgrade the Margins CLI, or ask an admin to check ' +
      'the workspace.',
    )
  }

  return {
    files: resp?.files ?? {},
    headSha: resp?.headSha ?? null,
    ...(isContentMode(raw) ? { contentMode: raw } : {}),
  }
}

/**
 * Settle the mode this push will collect under, before collecting (R4, R5, KTD2).
 *
 * - The server reports a mode → that mode wins. A flag requesting a different
 *   one is refused: content mode is a workspace setting, and alternating modes
 *   against one workspace deletes whatever the other mode legitimately sent.
 * - The server reports NO mode → it predates the feature. Working-tree pushes
 *   proceed exactly as they do today; a committed push is refused, and the
 *   message names the SERVER, because the user's flags are not the problem.
 */
export function resolveContentMode(
  preflight: SyncPreflight,
  requested: ContentMode | undefined,
): ContentMode {
  const workspaceMode = preflight.contentMode

  if (workspaceMode === undefined) {
    if (requested === 'committed') {
      throw new ValidationError(
        'This Margins server does not support committed content mode — it reports no ' +
        'content mode for this workspace. A committed push could not be enforced there, ' +
        'so nothing was sent. Upgrade the server, then retry.',
      )
    }
    return 'working-tree'
  }

  if (requested !== undefined && requested !== workspaceMode) {
    throw new ValidationError(
      `--content-mode ${requested} contradicts this workspace, which is in ${workspaceMode} ` +
      'mode — nothing was collected or sent. Content mode is a workspace setting, not a ' +
      'per-push choice: change it with `margins workspace content-mode`.',
    )
  }

  return workspaceMode
}

/** Parse the `--content-mode` flag, refusing an unknown value locally. */
export function parseContentModeFlag(raw: string | undefined): ContentMode | undefined {
  if (raw === undefined) return undefined
  if (isContentMode(raw)) return raw
  throw new ValidationError(
    `Unknown --content-mode "${raw}". Use "working-tree" or "committed".`,
  )
}

/**
 * The single wording for a collection that produced no markdown (R8).
 *
 * Both `workspace push` and `sync` emit THIS string, byte for byte, so a user
 * who moves between them is told the same thing. Neither of them exits early on
 * it any more: an empty push against a populated branch has to reach the
 * full-delete guard, which is the thing that actually refuses the destructive
 * case.
 */
export function emptyCollectionMessage(dir: string, mode: ContentMode): string {
  return mode === 'committed'
    ? `Nothing to send: the commit being synced holds no .md files (${dir}). ` +
      'In committed mode only files tracked by git are sent, so untracked and ' +
      'gitignored markdown is never included.'
    : `Nothing to send: no .md files found in ${dir}.`
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
 * The preflight (step 0) is the CALLER's — {@link fetchSyncPreflight} runs
 * before collection so the content mode is settled first (KTD3), and its result
 * is handed in here. That is why `parentSha` below is not a local lookup: it is
 * the `headSha` the caller already fetched, so the CAS swap is against the state
 * the caller made its collection decision on.
 *
 * 1. Compute SHA-256 of each collected file, diff against the preflight manifest
 * 2. Refuse a push that would empty a populated branch, unless confirmed
 * 3. Upload new/changed blobs (up to 5 concurrent), each declaring the content
 *    mode it was collected under
 * 4. Commit the new manifest with a synthetic commitSha (derived from the
 *    local manifest, see {@link syntheticCommitSha}) and parentSha = the
 *    preflight's headSha, declaring the same content mode. SHAs are computed
 *    here — callers never supply them (git SHAs are the wrong shape AND the
 *    wrong semantics).
 *
 * On ANY 409 the push surfaces-and-stops — it is NEVER re-pushed. Post-PR2 the
 * server 3-way-merges a divergent push, so a 409 is always a real content
 * conflict (SYNC_MERGE_CONFLICT); re-pushing would clobber the writer the
 * server preserved. An unrecognized 409 is treated the same way (a hard
 * conflict to reconcile), never an overwrite. The CLI writes no local files,
 * so the user's working copy is preserved.
 */
export interface CasSyncOptions {
  /** The caller's preflight for this branch (see {@link fetchSyncPreflight}). */
  preflight: SyncPreflight
  /**
   * The mode `files` were ACTUALLY collected under — never a default. Declared
   * on the manifest POST and on every blob upload, so a workspace in committed
   * mode can refuse a client that collected the working tree.
   */
  contentMode: ContentMode
  /**
   * Allow a push that would delete every file on the branch. Without it, such a
   * push is refused locally (nothing destructive is sent) and the server's
   * matching guard (`SYNC_FULL_DELETE_NOT_CONFIRMED`) is a backstop.
   */
  confirmFullDelete?: boolean
  /**
   * Which git commit this push was collected from — committed mode only; a
   * working-tree push omits it and records nothing (wire contract §6).
   *
   * It rides BESIDE `commitSha`/`parentSha` and never replaces them. Overloading
   * those would break two things that depend on sha-means-content: the
   * idempotent-retry check would treat a genuinely different tree as already
   * applied, and divergence detection compares against the branch head.
   */
  gitProvenance?: GitProvenance
}

export async function casSync(
  client: ApiClient,
  workspaceId: string,
  branch: string,
  files: SyncFile[],
  opts: CasSyncOptions,
): Promise<CasSyncResult> {
  const basePath = syncBasePath(workspaceId)
  const { preflight, contentMode } = opts

  // Every write declares the mode this push collected under (KTD13).
  const declaration = { [CONTENT_MODE_HEADER]: contentMode }

  const serverFiles = preflight.files ?? {}

  // Step 1: Compute local hashes and diff
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

  // Step 3: Upload blobs concurrently, each declaring the collected mode
  const toUpload = [...hashesToUpload]

  await poolMap(toUpload, UPLOAD_CONCURRENCY, async (hash) => {
    const file = localByHash.get(hash)!
    await client.putRaw(
      `${basePath}/objects/${hash}`,
      file.content,
      file.contentType,
      declaration,
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
      parentSha: preflight.headSha,
      files: localFiles,
      ...(opts.confirmFullDelete ? { confirmFullDelete: true } : {}),
      // Both fields together or neither — the server 400s a length/format
      // contradiction, and omitting both is what a working-tree push does.
      ...(opts.gitProvenance ?? {}),
    }, declaration)
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
