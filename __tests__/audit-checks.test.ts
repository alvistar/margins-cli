import { describe, it, expect } from 'vitest'
import { findWorkspaceByRepoUrl, type WorkspaceListItem } from '../src/lib/audit-checks.js'

const ws = (repoUrl: string | null, id = 'ws-1'): WorkspaceListItem => ({
  id,
  slug: 'acme/docs',
  name: 'docs',
  repoUrl,
  syncMode: 'client',
  defaultBranch: 'main',
})

describe('findWorkspaceByRepoUrl', () => {
  it('matches the canonical https form', () => {
    expect(findWorkspaceByRepoUrl([ws('https://github.com/acme/docs')], 'acme/docs')?.id).toBe('ws-1')
  })

  it('matches a stored URL with a .git suffix', () => {
    expect(findWorkspaceByRepoUrl([ws('https://github.com/acme/docs.git')], 'acme/docs')?.id).toBe('ws-1')
  })

  it('matches a stored URL with a trailing slash', () => {
    expect(findWorkspaceByRepoUrl([ws('https://github.com/acme/docs/')], 'acme/docs')?.id).toBe('ws-1')
  })

  it('matches an ssh-format stored URL', () => {
    expect(findWorkspaceByRepoUrl([ws('git@github.com:acme/docs.git')], 'acme/docs')?.id).toBe('ws-1')
    expect(findWorkspaceByRepoUrl([ws('ssh://git@github.com/acme/docs.git')], 'acme/docs')?.id).toBe('ws-1')
  })

  it('compares owner/repo case-insensitively in both directions', () => {
    expect(findWorkspaceByRepoUrl([ws('https://github.com/ACME/Docs')], 'acme/docs')?.id).toBe('ws-1')
    expect(findWorkspaceByRepoUrl([ws('https://github.com/acme/docs')], 'ACME/DOCS')?.id).toBe('ws-1')
  })

  it('returns undefined for a different repo, a non-GitHub URL, or a null repoUrl', () => {
    expect(findWorkspaceByRepoUrl([ws('https://github.com/acme/other')], 'acme/docs')).toBeUndefined()
    expect(findWorkspaceByRepoUrl([ws('https://gitlab.com/acme/docs')], 'acme/docs')).toBeUndefined()
    expect(findWorkspaceByRepoUrl([ws(null)], 'acme/docs')).toBeUndefined()
  })
})
