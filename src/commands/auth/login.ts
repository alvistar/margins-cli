import * as http from 'node:http'
import * as p from '@clack/prompts'
import * as oauth from 'oauth4webapi'
import open from 'open'
import type { ResolvedConfig } from '../../lib/config.js'
import { setGlobalConfig } from '../../lib/config.js'
import { LoginTimeout, OAuthError } from '../../lib/errors.js'

const LOGIN_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes
const PORT_RANGE_START = 9876
const PORT_RANGE_END = 9886

function randomPortStart(): number {
  const width = PORT_RANGE_END - PORT_RANGE_START + 1
  return PORT_RANGE_START + Math.floor(Math.random() * width)
}

// Request offline_access so Keycloak issues a refresh token.
// Without this, some Keycloak configs won't include a refresh token.
const SCOPES = 'openid email profile offline_access'

function findAvailablePort(start: number, end: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > end) { reject(new Error('No available ports')); return }
      const server = http.createServer()
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port))
      })
      server.on('error', () => tryPort(port + 1))
    }
    tryPort(start)
  })
}

// Returns the full URLSearchParams from the callback so that iss and other
// RFC 9207 parameters (sent by Keycloak v22+) are preserved for oauth4webapi.
function waitForCallback(port: number, expectedState: string): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const params = url.searchParams
      const error = params.get('error')
      const errorDesc = params.get('error_description')
      const state = params.get('state')
      const code = params.get('code')

      // Stop accepting new connections immediately
      server.close()

      const closeServer = () => server.closeAllConnections?.()

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Login failed. Check the CLI for details.</h2></body></html>', () => {
          closeServer()
          reject(new OAuthError(errorDesc ?? error))
        })
        return
      }
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Login failed: security check failed.</h2></body></html>', () => {
          closeServer()
          reject(new OAuthError('state mismatch'))
        })
        return
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Login failed: no authorization code received.</h2></body></html>', () => {
          closeServer()
          reject(new Error('No code in callback'))
        })
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      // Resolve before flushing so token exchange starts immediately.
      // closeAllConnections() runs after the response is flushed so the browser
      // sees the "Login complete" page before the socket is torn down.
      resolve(params)
      res.end('<html><body><h2>Login complete. You can close this tab.</h2></body></html>', closeServer)
    })

    server.listen(port, '127.0.0.1')
    server.on('error', reject)
  })
}

export async function handleLogin(cfg: ResolvedConfig): Promise<void> {
  const serverUrl = cfg.serverUrl

  let issuerUrl: URL
  let clientId: string
  try {
    const res = await fetch(`${serverUrl}/api/auth/cli-config`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { issuer: string; clientId: string }
    issuerUrl = new URL(json.issuer)
    clientId = json.clientId
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    p.log.warning(`Could not fetch config from ${serverUrl}/api/auth/cli-config: ${reason}`)
    p.log.info(`Make sure your server URL is set correctly: margins config set-url <url>`)
    const issuer = await p.text({
      message: 'Enter Keycloak issuer URL (e.g. https://auth.example.com/realms/margins)',
      validate: (v) => { try { new URL(v); return undefined } catch { return 'Invalid URL' } },
    })
    if (p.isCancel(issuer)) { p.cancel('Login cancelled'); process.exit(0) }
    issuerUrl = new URL(issuer as string)
    clientId = 'margins-cli'
  }

  const startPort = randomPortStart()
  const port = await findAvailablePort(startPort, PORT_RANGE_END).catch(() =>
    findAvailablePort(PORT_RANGE_START, startPort - 1),
  )
  const redirectUri = `http://127.0.0.1:${port}/callback`

  // Discover OIDC server metadata
  const as = await oauth.discoveryRequest(issuerUrl, { algorithm: 'oidc' })
    .then((r) => oauth.processDiscoveryResponse(issuerUrl, r))

  // Generate PKCE
  const codeVerifier = oauth.generateRandomCodeVerifier()
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier)
  const state = oauth.generateRandomState()

  if (!as.authorization_endpoint) {
    throw new OAuthError('Keycloak discovery did not return an authorization_endpoint')
  }

  const authUrl = new URL(as.authorization_endpoint)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)

  p.intro('Logging in to Margins')
  const spinner = p.spinner()
  spinner.start('Opening browser...')

  try {
    await open(authUrl.toString())
    spinner.stop('Browser opened. Complete login in your browser.')
  } catch {
    spinner.stop(`Couldn't open browser. Open this URL manually:\n  ${authUrl.toString()}`)
  }

  // Wait for callback (includes iss from Keycloak v22+).
  // clearTimeout is mandatory — the losing setTimeout arm keeps the Node.js event
  // loop alive indefinitely if not cleared, causing the process to hang after login.
  let loginTimeoutId: ReturnType<typeof setTimeout> | undefined
  const callbackParams = await Promise.race([
    waitForCallback(port, state),
    new Promise<never>((_, reject) => {
      loginTimeoutId = setTimeout(() => reject(new LoginTimeout()), LOGIN_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(loginTimeoutId))

  spinner.start('Completing authentication...')

  const client: oauth.Client = { client_id: clientId, token_endpoint_auth_method: 'none' }

  let params: URLSearchParams
  try {
    params = oauth.validateAuthResponse(as, client, callbackParams, state)
  } catch (err) {
    throw new OAuthError(err instanceof Error ? err.message : String(err))
  }

  // Public client — use oauth.None() (oauth4webapi v3 rejects ClientSecretPost(''))
  const tokenResponse = await oauth.authorizationCodeGrantRequest(
    as, client, oauth.None(), params, redirectUri, codeVerifier,
  )
  const result = await oauth.processAuthorizationCodeResponse(as, client, tokenResponse)

  const accessToken = result.access_token
  const refreshToken = result.refresh_token
  // expires_in is seconds from now; store as absolute epoch ms
  const expiresIn = result.expires_in ?? 300 // default 5 min if not provided
  const accessTokenExpiresAt = Date.now() + expiresIn * 1000

  // Store Keycloak tokens directly — no Margins API key needed.
  // The server's resolveUser() validates the JWT on each request.
  // The API client transparently refreshes when the access token expires.
  setGlobalConfig({
    accessToken,
    refreshToken: refreshToken ?? undefined,
    accessTokenExpiresAt,
    keycloakIssuer: issuerUrl.toString(),
    keycloakClientId: clientId,
    // Clear any previously stored Margins API key so the token takes precedence
    apiKey: undefined,
  })

  spinner.stop('Logged in successfully. Session saved.')
  p.outro(refreshToken
    ? `Session active. Refresh token stored — you will not need to log in again for a while.`
    : `Session active. No refresh token — you may need to log in again when the session expires.`,
  )
}
