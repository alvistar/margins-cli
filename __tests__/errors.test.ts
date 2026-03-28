import { describe, it, expect } from 'vitest'
import {
  AuthMissing, AuthExpired, AuthInvalid, NetworkError, ServerError,
  ForbiddenError, NotFoundError, TimeoutError, ResponseParseError,
  ConfigParseError, ValidationError, LoginTimeout, OAuthError, MarginsError,
} from '../src/lib/errors.js'

describe('error classes', () => {
  it('AuthMissing has exitCode 1 and actionable userMessage', () => {
    const e = new AuthMissing()
    expect(e.exitCode).toBe(1)
    expect(e.userMessage).toContain('margins auth login')
    expect(e instanceof MarginsError).toBe(true)
  })

  it('AuthExpired has exitCode 1 and actionable userMessage', () => {
    const e = new AuthExpired()
    expect(e.exitCode).toBe(1)
    expect(e.userMessage).toContain('margins auth login')
  })

  it('AuthInvalid has exitCode 1 and actionable userMessage', () => {
    const e = new AuthInvalid()
    expect(e.exitCode).toBe(1)
    expect(e.userMessage).toContain('margins auth login')
  })

  it('NetworkError includes server URL in message', () => {
    const e = new NetworkError('https://margins.app')
    expect(e.exitCode).toBe(1)
    expect(e.userMessage).toContain('https://margins.app')
    expect(e.userMessage).toContain('Check your connection')
  })

  it('ServerError includes status code', () => {
    const e = new ServerError(503)
    expect(e.userMessage).toContain('503')
  })

  it('ForbiddenError includes resource', () => {
    const e = new ForbiddenError('workspace')
    expect(e.userMessage).toContain('workspace')
  })

  it('NotFoundError includes resource', () => {
    const e = new NotFoundError('gh/owner/repo')
    expect(e.userMessage).toContain('gh/owner/repo')
  })

  it('TimeoutError has retry message', () => {
    const e = new TimeoutError()
    expect(e.userMessage).toContain('Try again')
  })

  it('ResponseParseError suggests --verbose', () => {
    const e = new ResponseParseError()
    expect(e.userMessage).toContain('--verbose')
  })

  it('ConfigParseError includes detail', () => {
    const e = new ConfigParseError('Invalid .margins.json at /some/path')
    expect(e.userMessage).toContain('Invalid .margins.json')
  })

  it('ValidationError passes through message as userMessage', () => {
    const e = new ValidationError('Required option --body not provided')
    expect(e.userMessage).toContain('--body')
  })

  it('LoginTimeout has actionable message', () => {
    const e = new LoginTimeout()
    expect(e.userMessage).toContain('2 min')
  })

  it('OAuthError includes reason', () => {
    const e = new OAuthError('access_denied')
    expect(e.userMessage).toContain('access_denied')
  })
})
