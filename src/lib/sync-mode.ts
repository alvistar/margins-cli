/**
 * The sync mode vocabulary — the one owner of the words.
 *
 * Margins calls the two modes **push** (content is pushed to Margins) and
 * **pull** (Margins pulls the workspace from GitHub). The CLI uses those words
 * everywhere a person or a file sees them: output, `--json`, `.margins.json`.
 *
 * The server API and database keep their own values, `client` (push) and
 * `server` (pull). Translate at the API boundary only, through
 * {@link toApiSyncMode} / {@link fromApiSyncMode}; nothing past the boundary
 * holds an API value.
 *
 * `.margins.json` files written before 0.23.0 (and by the legacy Margins Sync
 * tray app, which still writes them) say `"client"` / `"server"`. Those are
 * read as deprecated aliases and the file is rewritten in place to the new
 * word, with one line on stderr — the file is usually committed.
 */
import * as fs from 'node:fs'

export type SyncMode = 'push' | 'pull'
export type ApiSyncMode = 'client' | 'server'

/** The API value for a mode, for request bodies. */
export function toApiSyncMode(mode: SyncMode): ApiSyncMode {
  return mode === 'push' ? 'client' : 'server'
}

/**
 * A mode from an API value. A missing or unknown value is `null` — NEVER push:
 * reading an unknown answer as push is how a workspace that pulls from GitHub
 * used to be treated as one that takes pushes (ai-review#282).
 */
export function fromApiSyncMode(value: unknown): SyncMode | null {
  if (value === 'client') return 'push'
  if (value === 'server') return 'pull'
  return null
}

const DEPRECATED: Record<ApiSyncMode, SyncMode> = { client: 'push', server: 'pull' }

/**
 * A `.margins.json` `syncMode` value: the new words, or a deprecated alias
 * (reported in `deprecated` so the caller can rewrite the file). Anything else
 * is `null` — not a sync mode.
 */
export function parseFileSyncMode(value: unknown): { mode: SyncMode; deprecated?: ApiSyncMode } | null {
  if (value === 'push' || value === 'pull') return { mode: value }
  if (value === 'client' || value === 'server') return { mode: DEPRECATED[value], deprecated: value }
  return null
}

/** The one line printed when a deprecated alias is rewritten. */
export function deprecatedRewriteLine(from: ApiSyncMode, to: SyncMode): string {
  return `Updated .margins.json: "syncMode": "${from}" → "${to}" — commit it.`
}

/**
 * Rewrite a deprecated `syncMode` in the `.margins.json` at `configPath` to the
 * new word, and say so once on stderr. Reads the FILE's value, so it is
 * idempotent: a second call finds nothing to do and prints nothing. A missing
 * or malformed file is left alone. True when the file was rewritten.
 */
export function upgradeDeprecatedSyncMode(configPath: string): boolean {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return false
  }
  if (!raw || typeof raw !== 'object') return false
  const parsed = parseFileSyncMode(raw.syncMode)
  if (!parsed?.deprecated) return false
  raw.syncMode = parsed.mode
  try {
    // Temp file + rename: a concurrent reader (the hook runs one process per
    // branch) sees the old file or the new one, never a truncated one.
    const tmp = `${configPath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
    try {
      fs.renameSync(tmp, configPath)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }
  } catch {
    // Read-only checkout: the alias is still read correctly; nothing to report.
    return false
  }
  console.error(deprecatedRewriteLine(parsed.deprecated, parsed.mode))
  return true
}

/**
 * Read a `.margins.json`, rewriting a deprecated `syncMode` first. Throws what
 * `JSON.parse` throws on a malformed file — each caller already decides what a
 * malformed file means for it.
 */
export function readMarginsJson<T = Record<string, unknown>>(configPath: string): T {
  const text = fs.readFileSync(configPath, 'utf-8')
  const raw = JSON.parse(text) as Record<string, unknown>
  if (raw && typeof raw === 'object') {
    const parsed = parseFileSyncMode(raw.syncMode)
    if (parsed?.deprecated) {
      upgradeDeprecatedSyncMode(configPath)
      raw.syncMode = parsed.mode
    }
  }
  return raw as T
}
