import { MarginsError } from './errors.js'

// ─── Color support detection ──────────────────────────────────────────────────

export function hasColor(): boolean {
  return !process.env['NO_COLOR'] && process.stdout.isTTY !== false
}

// ─── Key masking ──────────────────────────────────────────────────────────────

export function maskKey(key: string | undefined): string {
  if (!key) return '(not set)'
  if (key.length < 10) return `${key.slice(0, 2)}...`
  return `${key.slice(0, 5)}...${key.slice(-3)}`
}

// ─── JSON output ──────────────────────────────────────────────────────────────

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

// ─── Error formatting ─────────────────────────────────────────────────────────

export function formatError(err: unknown, json: boolean): string {
  if (json) {
    const message = err instanceof MarginsError
      ? err.userMessage
      : err instanceof Error
        ? err.message
        : String(err)
    const code = err instanceof MarginsError
      ? err.constructor.name
      : 'UnknownError'
    return JSON.stringify({ error: message, code })
  }

  if (err instanceof MarginsError) return `Error: ${err.userMessage}`
  if (err instanceof Error) return `Error: ${err.message}`
  return `Error: ${String(err)}`
}

// ─── Table formatting ─────────────────────────────────────────────────────────

export function formatTable(
  headers: string[],
  rows: string[][],
  emptyMessage?: string,
): string {
  if (rows.length === 0) return emptyMessage ?? ''

  // Compute column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )

  const sep = widths.map((w) => '─'.repeat(w + 2)).join('┼')
  const header = headers.map((h, i) => ` ${h.padEnd(widths[i]!)} `).join('│')
  const rowLines = rows.map((r) =>
    r.map((cell, i) => ` ${(cell ?? '').padEnd(widths[i]!)} `).join('│'),
  )

  return [header, sep, ...rowLines].join('\n')
}

// ─── Hint / success output ────────────────────────────────────────────────────

export function hint(message: string): string {
  return `  ${message}`
}
