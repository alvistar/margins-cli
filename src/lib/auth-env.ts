/**
 * GitHub Actions OIDC satisfies CLI auth without a stored api key: the workflow
 * either passes a minted token (MARGINS_OIDC_TOKEN) or the runtime token-request
 * env the api-client mints from (ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN). Either lets
 * the api-client produce a bearer, so the preAction auth gate must treat their
 * presence as authenticated — otherwise the composite action, which runs
 * `workspace push` with no api key, is blocked before the push handler runs.
 */
export function hasOidcAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env['MARGINS_OIDC_TOKEN'] ||
      (env['ACTIONS_ID_TOKEN_REQUEST_URL'] && env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']),
  )
}
