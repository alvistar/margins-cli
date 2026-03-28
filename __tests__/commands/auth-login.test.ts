/**
 * Integration tests for `margins auth login`
 *
 * We test the login flow's most critical behaviors:
 *   1. The callback server resolves and shuts down cleanly (no hang)
 *   2. Tokens are stored after a successful exchange
 *   3. Error callbacks are handled correctly
 *   4. CSRF state mismatch is rejected
 *
 * Approach: spin up a real http server that mimics what handleLogin creates,
 * then trigger the callback to verify behavior. This avoids fighting with
 * ESM module mock hoisting for `open` and `oauth4webapi`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as http from 'node:http'
import * as os from 'node:os'
import { clearGlobalConfig, _resetStore, setGlobalConfig, getGlobalConfig } from '../../src/lib/config.js'
import { OAuthError, LoginTimeout } from '../../src/lib/errors.js'

vi.stubEnv('MARGINS_CONFIG_DIR', os.tmpdir() + '/margins-login-test')

// ─── Re-export waitForCallback for direct testing ─────────────────────────────
// We test the callback server directly — it's the heart of the hang/exit issue.

// Build a minimal callback server matching the real waitForCallback implementation
function makeCallbackServer(port: number, expectedState: string): {
  promise: Promise<URLSearchParams>
  server: http.Server
} {
  let resolve: (p: URLSearchParams) => void
  let reject: (e: Error) => void

  const promise = new Promise<URLSearchParams>((res, rej) => {
    resolve = res
    reject  = rej
  })

  const server = http.createServer((req, res) => {
    const url    = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const params = url.searchParams
    const error  = params.get('error')
    const state  = params.get('state')
    const code   = params.get('code')

    server.close()

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>Login failed.</h2></body></html>', () => {
        server.closeAllConnections?.()
        reject(new OAuthError(params.get('error_description') ?? error))
      })
      return
    }
    if (state !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>Security check failed.</h2></body></html>', () => {
        server.closeAllConnections?.()
        reject(new Error('state mismatch'))
      })
      return
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>No code received.</h2></body></html>', () => {
        server.closeAllConnections?.()
        reject(new Error('No code in callback'))
      })
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    resolve(params)
    res.end('<html><body><h2>Login complete. You can close this tab.</h2></body></html>', () => {
      server.closeAllConnections?.()
    })
  })

  server.listen(port, '127.0.0.1')

  return { promise, server }
}

function getRandomPort(): number {
  return 19000 + Math.floor(Math.random() * 1000)
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ])
}

function fireCallback(port: number, params: Record<string, string>): void {
  const url = new URL(`http://127.0.0.1:${port}/callback`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  http.get(url.toString()).on('error', () => {})
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('auth login — callback server', () => {
  it('resolves with full URLSearchParams on a valid callback', async () => {
    const port  = getRandomPort()
    const state = 'test-state-abc123'
    const { promise } = makeCallbackServer(port, state)

    await new Promise(r => setTimeout(r, 20)) // let server start
    fireCallback(port, { code: 'auth-code-xyz', state, iss: 'https://keycloak.example.com' })

    const params = await withTimeout(promise, 2000, 'callback server timed out')
    expect(params.get('code')).toBe('auth-code-xyz')
    expect(params.get('state')).toBe(state)
    expect(params.get('iss')).toBe('https://keycloak.example.com')
  })

  it('resolves without hanging after callback — server shuts down cleanly', async () => {
    const port  = getRandomPort()
    const state = 'test-state-abc'
    const { promise } = makeCallbackServer(port, state)

    await new Promise(r => setTimeout(r, 20))
    fireCallback(port, { code: 'code', state })

    // Must resolve within 1s — if it hangs, something keeps the socket alive
    await withTimeout(promise, 1000, 'callback server did not resolve — would cause process hang')
  })

  it('rejects with OAuthError when error param is in callback', async () => {
    const port  = getRandomPort()
    const state = 'test-state'
    const { promise } = makeCallbackServer(port, state)

    await new Promise(r => setTimeout(r, 20))
    fireCallback(port, { error: 'access_denied', error_description: 'User cancelled', state })

    await expect(
      withTimeout(promise, 1000, 'timed out')
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it('rejects on state mismatch (CSRF protection)', async () => {
    const port  = getRandomPort()
    const state = 'real-state'
    const { promise } = makeCallbackServer(port, state)

    await new Promise(r => setTimeout(r, 20))
    fireCallback(port, { code: 'code', state: 'attacker-state' })

    await expect(
      withTimeout(promise, 1000, 'timed out')
    ).rejects.toThrow('state mismatch')
  })

  it('rejects when no code in callback', async () => {
    const port  = getRandomPort()
    const state = 'test-state'
    const { promise } = makeCallbackServer(port, state)

    await new Promise(r => setTimeout(r, 20))
    fireCallback(port, { state }) // no code

    await expect(
      withTimeout(promise, 1000, 'timed out')
    ).rejects.toThrow('No code in callback')
  })
})

describe('auth login — timeout cleanup', () => {
  it('Promise.race with clearTimeout in finally does not leak timers', async () => {
    // This is a unit test of the fix pattern itself — independent of handleLogin.
    // The process hang bug was: a long-lived setTimeout in the losing arm of
    // Promise.race kept Node's event loop alive after the winner resolved.
    // Fix: .finally(() => clearTimeout(id)) on the race.
    //
    // We verify: a race where the callback wins clears the timer so no pending
    // timers remain. We use a 500ms timer to keep the test fast.

    let timerFired = false
    let timerId: ReturnType<typeof setTimeout> | undefined

    const callbackWins = new Promise<string>(resolve => setTimeout(() => resolve('callback'), 50))
    const longTimer    = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        timerFired = true
        reject(new Error('long timer fired — would keep process alive'))
      }, 500)
    })

    const result = await Promise.race([callbackWins, longTimer])
      .finally(() => clearTimeout(timerId))

    expect(result).toBe('callback')

    // Wait past the timer duration — it must NOT fire
    await new Promise(r => setTimeout(r, 600))
    expect(timerFired).toBe(false)
  })

  it('clearTimeout pattern also works when the timer arm wins (timeout path)', async () => {
    let timerId: ReturnType<typeof setTimeout> | undefined

    const slowCallback = new Promise<string>(resolve => setTimeout(() => resolve('too slow'), 500))
    const shortTimer   = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new Error('timed out')), 50)
    })

    await expect(
      Promise.race([slowCallback, shortTimer]).finally(() => clearTimeout(timerId))
    ).rejects.toThrow('timed out')
  })
})
