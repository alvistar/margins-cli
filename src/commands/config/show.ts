import { getGlobalConfig } from '../../lib/config.js'
import { maskKey, formatJson, formatTable } from '../../lib/output.js'

export function handleShow(opts: { json: boolean }): string {
  const config = getGlobalConfig()
  const activeCredential = config.apiKey ?? config.accessToken
  const masked = maskKey(activeCredential)
  const serverUrl = config.serverUrl ?? '(not set)'

  if (opts.json) {
    return formatJson({ apiKey: masked, serverUrl })
  }

  const rows: string[][] = [
    ['API Key / Token', masked],
    ['Server URL', serverUrl],
  ]

  const table = formatTable(['Setting', 'Value'], rows)
  const hint = !activeCredential ? '\n  Run: margins auth login' : ''
  return table + hint
}
