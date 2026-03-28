import * as p from '@clack/prompts'
import * as oauth from 'oauth4webapi'
import type { ResolvedConfig } from '../../lib/config.js'
import { setGlobalConfig } from '../../lib/config.js'
import { AuthMissing } from '../../lib/errors.js'
import { formatJson } from '../../lib/output.js'

export async function handleLogout(cfg: ResolvedConfig): Promise<void> {
  // Allow logout if there's a refresh token even if the access token is expired
  if (!cfg.apiKey && !cfg.refreshToken) throw new AuthMissing()

  let tokenRevoked = false

  if (cfg.refreshToken && cfg.keycloakIssuer && cfg.keycloakClientId) {
    // Revoke the refresh token at the Keycloak revocation endpoint.
    // This invalidates the entire session (Keycloak revokes the access token too).
    try {
      const issuerUrl = new URL(cfg.keycloakIssuer)
      const as = await oauth.discoveryRequest(issuerUrl, { algorithm: 'oidc' })
        .then((r) => oauth.processDiscoveryResponse(issuerUrl, r))

      const client: oauth.Client = {
        client_id: cfg.keycloakClientId,
        token_endpoint_auth_method: 'none',
      }

      if (as.revocation_endpoint) {
        await oauth.revocationRequest(
          as, client, oauth.None(), cfg.refreshToken,
        )
        tokenRevoked = true
      }
    } catch {
      // Best-effort revocation — clear locally regardless
      if (cfg.json) {
        process.stderr.write(JSON.stringify({
          warning: 'Could not revoke session on Keycloak — cleared locally only',
        }) + '\n')
      } else {
        p.log.warning('Could not revoke session on Keycloak — cleared locally only')
      }
    }
  }

  // Clear auth fields only — preserve serverUrl so the user doesn't need to
  // re-run `margins config set-url` after every logout.
  setGlobalConfig({
    apiKey: undefined,
    accessToken: undefined,
    refreshToken: undefined,
    accessTokenExpiresAt: undefined,
    keycloakIssuer: undefined,
    keycloakClientId: undefined,
  })

  if (cfg.json) {
    console.log(formatJson({ loggedOut: true, tokenRevoked }))
    return
  }

  p.outro('Logged out. Session cleared.')
}
