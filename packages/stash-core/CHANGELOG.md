# Changelog

All notable changes to `margins-stash-core` will be documented in this file.

## [0.1.0] - 2026-09-09

First release. Extracted from `margins-cli` 0.19.0 with no behaviour change: the CLI's
existing tests for the stash update path pass against it with their assertions untouched.

### Added

- `getConfigDir`, `getGlobalConfig`, `setGlobalConfig`, `clearGlobalConfig` — the shared
  `config.json` store and its three-step directory resolution.
- `resolveCredential` — the credential a background caller may use. Narrower than the CLI's
  own resolution on purpose: no argv, no `.margins.json` walk, and a Keycloak session is
  refused (`SESSION_ONLY`) rather than ridden, because a daemon can neither refresh one nor
  prompt when the refresh fails.
- `resolveBindingStore`, `lookupBinding`, `recordBinding`, `removeBinding`, `isAccepted`,
  `recordAcceptance` — the file→stash binding store, its project-versus-global choice, the
  R13 trust rule, and the symlink guard on both.
- `upsertStash` — create-or-update with the R11 recovery matrix, returning a discriminated
  result instead of printing or prompting. Trust is a callback; absent means refuse.
- `createFetchStashHttp` — a bearer-only transport with `get`, `post` and `put` that returns a
  status instead of throwing one, so a body-less 404 stays distinguishable from an enveloped
  one. `get` exists for the update precondition: a caller reads the stash's current head from
  `GET /api/stash` and sends it as `parentSha`, so an update cannot silently replace an edit
  made elsewhere.
- `buildStashReviewUrl`, `STASH_DOC_BRANCH`, `STASH_DOC_PATH`.
