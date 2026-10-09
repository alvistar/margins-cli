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

  it('a 5xx keeps the generic wording and never shows the server\'s message', () => {
    const e = new ServerError(500, 'INTERNAL', 'connection to db-7 refused')
    expect(e.userMessage).toBe('Server error (500). Try again later.')
  })

  it('a 4xx carries the server\'s reason and code, and does not say "try again later"', () => {
    const e = new ServerError(400, 'INVALID_BODY', 'parentSha must be a hex SHA')
    expect(e.userMessage).toBe('Margins refused the request (400 INVALID_BODY): parentSha must be a hex SHA')
    expect(e.userMessage).not.toMatch(/try again later/i)
    // Public fields unchanged for existing callers.
    expect(e.status).toBe(400)
    expect(e.code).toBe('INVALID_BODY')
    expect(e.serverMessage).toBe('parentSha must be a hex SHA')
  })

  it('a 4xx with no body still refuses without "try again later"', () => {
    expect(new ServerError(405).userMessage).toBe('Margins refused the request (405).')
    expect(new ServerError(413, 'TOO_LARGE').userMessage).toBe('Margins refused the request (413 TOO_LARGE).')
    expect(new ServerError(422, undefined, 'No.').userMessage).toBe('Margins refused the request (422): No.')
  })

  it('a 4xx with validation details names each field', () => {
    const e = new ServerError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'parentSha', message: 'must be a hex SHA' },
      { field: '', message: 'Required' },
    ])
    expect(e.userMessage).toBe(
      'Margins refused the request (400 VALIDATION_ERROR): Validation failed — parentSha: must be a hex SHA; Required',
    )
    expect(e.serverMessage).toBe('Validation failed')
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
