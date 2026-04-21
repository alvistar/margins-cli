import { describe, it, expect } from 'vitest'
import { parseGithubUrl, sanitizeProjectName } from '../src/lib/detect-git-remote.js'

describe('parseGithubUrl', () => {
  it('parses HTTPS URL', () => {
    expect(parseGithubUrl('https://github.com/org/repo.git')).toEqual({
      type: 'github', owner: 'org', repo: 'repo',
    })
  })

  it('parses HTTPS URL without .git suffix', () => {
    expect(parseGithubUrl('https://github.com/org/repo')).toEqual({
      type: 'github', owner: 'org', repo: 'repo',
    })
  })

  it('parses SSH URL (git@)', () => {
    expect(parseGithubUrl('git@github.com:org/repo.git')).toEqual({
      type: 'github', owner: 'org', repo: 'repo',
    })
  })

  it('parses SSH URL without .git suffix', () => {
    expect(parseGithubUrl('git@github.com:org/repo')).toEqual({
      type: 'github', owner: 'org', repo: 'repo',
    })
  })

  it('parses ssh:// URL', () => {
    expect(parseGithubUrl('ssh://git@github.com/org/repo.git')).toEqual({
      type: 'github', owner: 'org', repo: 'repo',
    })
  })

  it('returns other for non-GitHub remote', () => {
    expect(parseGithubUrl('https://gitlab.com/org/repo.git')).toEqual({
      type: 'other', url: 'https://gitlab.com/org/repo.git',
    })
  })

  it('returns other for Bitbucket', () => {
    expect(parseGithubUrl('git@bitbucket.org:org/repo.git')).toEqual({
      type: 'other', url: 'git@bitbucket.org:org/repo.git',
    })
  })

  it('returns none for empty string', () => {
    expect(parseGithubUrl('')).toEqual({ type: 'none' })
  })
})

describe('sanitizeProjectName', () => {
  it('lowercases and replaces spaces', () => {
    expect(sanitizeProjectName('My Cool Project')).toBe('my-cool-project')
  })

  it('strips special characters', () => {
    expect(sanitizeProjectName('Project! @#$% Name')).toBe('project-name')
  })

  it('collapses multiple dashes', () => {
    expect(sanitizeProjectName('a---b')).toBe('a-b')
  })

  it('trims leading/trailing dashes', () => {
    expect(sanitizeProjectName('-hello-')).toBe('hello')
  })

  it('truncates to 64 chars', () => {
    const long = 'a'.repeat(100)
    expect(sanitizeProjectName(long).length).toBe(64)
  })

  it('returns workspace for empty input', () => {
    expect(sanitizeProjectName('')).toBe('workspace')
  })
})
