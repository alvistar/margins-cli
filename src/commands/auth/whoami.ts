import * as p from '@clack/prompts'
import type { ResolvedConfig } from '../../lib/config.js'
import { createApiClient } from '../../lib/api-client.js'
import { formatJson, formatTable, maskKey } from '../../lib/output.js'
import { AuthMissing } from '../../lib/errors.js'

interface WhoamiResponse {
  user: {
    id: string
    name: string | null
    email: string | null
    avatarUrl: string | null
  }
  key: {
    id: string
    label: string | null
    role: string
    createdAt: string
    lastUsedAt: string | null
    expiresAt: string | null
  } | null
}

export async function handleWhoami(cfg: ResolvedConfig): Promise<void> {
  if (!cfg.apiKey) throw new AuthMissing()

  const client = createApiClient(cfg)
  const data = await client.get('/api/auth/whoami') as WhoamiResponse

  const { user, key } = data

  // JSON output uses ISO-8601 (script-friendly); human output uses locale date string
  const expiresAtHuman = key?.expiresAt
    ? new Date(key.expiresAt).toLocaleDateString()
    : 'never'

  if (cfg.json) {
    console.log(formatJson({
      user: {
        name: user.name,
        email: user.email,
      },
      key: key ? {
        label: key.label,
        role: key.role,
        expiresAt: key.expiresAt ?? null,
      } : null,
    }))
    return
  }

  p.intro('Authenticated')
  const rows: string[][] = [
    ['Name', user.name ?? '(unknown)'],
    ['Email', user.email ?? '(unknown)'],
  ]

  if (key) {
    rows.push(
      ['Key label', key.label ?? '(unlabeled)'],
      ['Role', key.role],
      ['API key', maskKey(cfg.apiKey)],
      ['Expires', expiresAtHuman],
      ['Last used', key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'never'],
    )
  } else {
    rows.push(['Auth method', 'Browser session'])
  }

  console.log(formatTable(['Field', 'Value'], rows))
}
