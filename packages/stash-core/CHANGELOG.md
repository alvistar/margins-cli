# Changelog

All notable changes to `margins-stash-core` will be documented in this file.

## [0.2.0] - 2026-09-15

Additive. Every existing caller compiles and behaves identically: `format` absent
still means Markdown, and a create with no `format` sends the byte-identical body
it always sent.

### Added

- `StashFormat`, `STASH_DOC_PATH_HTML`, `MAX_STASH_CONTENT`, `HTML_STASH_FEATURE`.
- `UpsertStashOptions.format` — sent on create only when `html`, and on update
  whenever known so the server can refuse a stash holding the other format before
  it writes.
- `UpsertStashOptions.force` — update with no `parentSha`.
- `StashUpsertSuccess.format` and `.path`, read from the server's response, so a
  caller never has to guess a design's document name.
- `StashUpsertSuccess.unprotectedUpdate` — the update went out with no
  `parentSha` because the binding predates head tracking. A flag rather than a
  printed warning: this package never prints, and the caller owns the wording.
- `StashFailure.strandedSlug` and `.serverVersion`, and the `HTML_UNSUPPORTED`
  and `FORMAT_MISMATCH` failure codes.
- `buildStashReviewUrl` takes an optional `path`, defaulting to `document.md`.
- `HTML_STASH_FEATURE` and an `/api/health` preflight before an html create. A
  server that predates `format` does not error — it ignores the field and stores
  the HTML source as Markdown — so asking first is the only way to fail honestly.

  It reads `features`, NOT `version`. The version there means two different
  things: the production image bakes in the web app's version, while a server
  started from `margins/` falls back to `npm_package_version`, the Margins Light
  runtime version on an unrelated numbering line. Measured 2026-09-15, a fully
  capable dev server reported `0.16.0` and a version comparison refused to
  publish a design to it. A server advertising no `features` cannot be asked and
  falls through to the create, where a missing `format`/`path` echo is the
  backstop.

### Changed

- `StashBinding.head` records the branch head after every create and update, sent
  back as `parentSha` on the next update. **Optional, and the file version stays
  1**: a v2 would make this package treat every binding written before this as
  unsupported and discard it, forking a duplicate of every stash those bindings
  point at.

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
