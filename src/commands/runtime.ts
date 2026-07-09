/**
 * `margins runtime list | which | clean` (M2 U7) — operate the per-version runtime cache under
 * ~/.margins/runtime/. `list` shows cached versions + sizes (newest = active), `which` names the
 * active one, `clean` frees space by removing all but the active. (ensureRuntime also auto-prunes
 * to active + previous on every install, so the cache can't grow unbounded even without `clean`.)
 */
import { listRuntimes, cleanRuntimes } from '../lib/runtime.js'
import { formatJson, formatTable } from '../lib/output.js'

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)}${units[i]}`
}

export function handleRuntimeList(json: boolean): string {
  const runtimes = listRuntimes()
  if (json) {
    return formatJson(
      runtimes.map((r, i) => ({ version: r.version, active: i === 0, sizeBytes: r.sizeBytes, path: r.path })),
    )
  }
  if (runtimes.length === 0) {
    return 'No Margins Light runtimes cached. Run `margins open <folder>` to install one.'
  }
  const rows = runtimes.map((r, i) => [
    r.version + (i === 0 ? ' (active)' : ''),
    humanSize(r.sizeBytes),
    r.path,
  ])
  return formatTable(['version', 'size', 'path'], rows)
}

export function handleRuntimeWhich(json: boolean): string {
  const active = listRuntimes()[0]
  if (json) return formatJson(active ? { version: active.version, path: active.path } : null)
  return active ? active.version : 'No Margins Light runtime cached.'
}

export function handleRuntimeClean(json: boolean): string {
  const active = listRuntimes()[0]?.version
  const removed = cleanRuntimes(active)
  if (json) return formatJson({ kept: active ?? null, removed })
  if (removed.length === 0) {
    return active
      ? `Nothing to clean — only the active runtime ${active} is cached.`
      : 'No Margins Light runtimes cached.'
  }
  return `Removed ${removed.length} runtime(s): ${removed.join(', ')}. Kept the active ${active}.`
}
