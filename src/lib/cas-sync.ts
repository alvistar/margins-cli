import { createHash } from 'node:crypto'
import type { ApiClient } from './api-client.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CasSyncResult {
  added: number
  changed: number
  deleted: number
  uploaded: number   // blobs actually transferred
  skipped: number    // blobs already on server
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
 * Run an async function for each item with bounded concurrency.
 * Returns results in the same order as items.
 */
async function poolMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++
      results[idx] = await fn(items[idx]!)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

// ─── CAS sync ────────────────────────────────────────────────────────────────

const UPLOAD_CONCURRENCY = 5

/**
 * Content-addressable sync protocol.
 *
 * 1. Fetch the server manifest for the branch
 * 2. Compute SHA-256 of each local file, diff against manifest
 * 3. Upload new/changed blobs (up to 5 concurrent)
 * 4. Commit the new manifest
 */
export async function casSync(
  client: ApiClient,
  workspaceId: string,
  branch: string,
  commitSha: string,
  parentSha: string | null,
  files: SyncFile[],
): Promise<CasSyncResult> {
  const basePath = `/api/workspaces/${workspaceId}/sync`

  // Step 1: Fetch current server manifest
  const manifest = await client.get(
    `${basePath}/manifest`,
    { branch },
  ) as ManifestResponse

  const serverFiles = manifest.files ?? {}

  // Step 2: Compute local hashes and diff
  const localFiles: Record<string, string> = {}
  const localByHash = new Map<string, SyncFile>()

  for (const file of files) {
    const hash = sha256(file.content)
    localFiles[file.path] = hash
    localByHash.set(hash, file)
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

  // Step 4: Commit the new manifest
  await client.post(`${basePath}/manifest`, {
    branch,
    commitSha,
    parentSha,
    files: localFiles,
  })

  return {
    added,
    changed,
    deleted,
    uploaded,
    skipped: files.length - added - changed,
  }
}
