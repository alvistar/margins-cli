import open from 'open'
import type { ResolvedConfig } from '../../lib/config.js'
import { readLocalConfig } from '../../lib/config.js'
import { ValidationError } from '../../lib/errors.js'

export async function handleOpen(cfg: ResolvedConfig, slug: string | undefined): Promise<void> {
  const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug
  if (!resolvedSlug) {
    throw new ValidationError('No workspace specified. Pass a slug or create .margins.json')
  }

  const url = `${cfg.serverUrl}/w/${resolvedSlug}`
  await open(url)
  console.log(`Opening: ${url}`)
}
