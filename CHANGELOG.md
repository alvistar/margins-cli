# Changelog

All notable changes to margins-cli will be documented in this file.

## [0.10.0] - 2026-06-25

### Added
- **`margins share <stash>` command.** Get a stable, shareable `/s/<slug>` link
  for an existing stash without leaving the terminal — accepts the stash slug
  (`stash/alice/1a2b3c4d`) or a full reader URL (the slug is parsed out). The
  server is get-or-create, so re-running prints the **same** link until it is
  revoked. `--json` for machine output. (U5)
- **`margins stash --share` flag.** Publish a stash and mint its share link in
  one step; prints both the review URL and the `/s/<slug>` link (and `shareUrl`
  in `--json`). (U5)
- Both paths **feature-detect an out-of-date server**: a `404` with no error body
  on `/api/stash/share` (the route is absent on older Margins) yields a clear
  "update the server" message and a non-zero exit — never a silent failure.
  `NotFoundError` now carries the server error code so callers can tell a real
  "stash not found" from a missing endpoint.

## [0.9.0] - 2026-06-25

### Added
- **`margins stash` command.** Publish a single markdown document to a Margins
  stash (a one-off, single-doc workspace) for review — from a file argument or
  piped stdin (`cat doc.md | margins stash`). POSTs to the existing `/api/stash`
  endpoint with the CLI's bearer auth and prints the review URL (`--json` for
  machine output). `--title` is derived from the document's first `#` heading,
  then the file name, when omitted. Reaches CLI / Claude Code parity with the
  `create_stash_doc` MCP tool and the Cowork `/margins-stash` command. (U1, U2)

## [0.8.0] - 2026-06-22

### Added
- **Client merge-conflict handling.** Now that the server 3-way-merges a divergent push, the CLI reads the manifest-push response and acts on it instead of clobbering the other writer:
  - On `409 SYNC_MERGE_CONFLICT` the push **surfaces the conflicting file(s)** and a reconcile next step, exits non-zero, and **never re-pushes** — the concurrent writer's change is preserved. (U1, U2)
  - On a clean `200` auto-merge the CLI reports the **server's merge counts** and advises that the local copy is now behind (pull / re-sync); `merged` is surfaced in `--json` output for `margins push` and `margins sync`. (U3)

### Changed
- **Any `409` from the manifest push now surfaces-and-stops.** The legacy refetch-and-retry-once path — which could overwrite a concurrent writer on a stale push — was removed; the CLI never re-pushes on a conflict. (Gates server PR #73 / v0.28.0.)
- `api-client` reads the server error code across all body shapes it ships (flat-string `{ error: "CODE" }`, nested `{ error: { code } }`, and top-level `{ code }`), fixing a latent gap where the live server's flat-string code was not read.

## [0.7.1] - 2026-06-11

### Changed
- Plugin skills invoke the CLI via the npm package (`npx margins-cli`) instead of the `github:` git-URL form, now that the CLI is published to npm. `margins-setup` documents `npm install -g margins-cli`.
- Stop committing `dist/` to git. It is rebuilt fresh by `release.yaml` before `npm publish` (so the published tarball is unchanged), and the git-URL install — the only consumer of a committed bundle — is retired in favour of npm. This removes the `check:dist` cross-platform churn (the bundler's content-hash output differs across OS/arch, so a dev-committed `dist/` could never byte-match CI's rebuild).

## [0.7.0] - 2026-06-11

### Added
- **Credentialless CI sync via GitHub Actions OIDC.** `margins workspace push` authenticates with a short-lived GitHub Actions OIDC token when `MARGINS_OIDC_TOKEN` (or the `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` pair to mint one) is present — no stored API key needed. The bearer resolver prefers the OIDC token over `mrgn_` keys and re-mints on a mid-push 401. (U3)
- **`margins install [target]`** — one-command repo onboarding to credentialless sync: creates the workspace, writes the OIDC trust binding, and opens a workflow PR. `--org <org>` (with `--include`/`--exclude` globs) onboards every repo in an org; `--dry-run` previews without writing. (U5)
- **`margins audit [target]`** — sync-coverage report across repos: missing workflows, stale action pins, binding drift, over-cap repos. `--org` for org-wide, `--csv` output. Runs in gh-only mode without margins credentials (drift checks skipped). (U6)
- **`syncMode` in `.margins.json`** (`server` | `client`) gates CLI commands: `workspace push` refuses server-managed-sync workspaces and points to `margins workspace sync`. The legacy `mode` field (`local`/`overlay`) is still read and upgraded in place. (faeaf73)
- **Client version header** (`X-Margins-Client`) on API requests.

### Changed
- **CAS push hardening:** synthetic SHA-256 commit hash + server `headSha` as `parentSha`; shared `collectSyncFiles` pipeline with cap pre-check metadata; oversized (>2 MB) blobs are skipped from upload *and* manifest rather than 413-aborting the whole push. (U3/U4)
- **Internal simplification:** shared repo-target + workspace-lookup helpers, deduped transport-error/re-mint paths, parallelized audit checks. (simplify pass)
- **`/margins` plugin skills synced with the rebuilt CLI/server API** (skill-drift audit): corrected the `workspace open` invocation, the `.margins.json` `syncMode` field, CAS delete semantics, push output shape, 413 caps (2 MB/blob + 1000-file manifest), and documented `install`/`audit`. Plugin bumped to 0.7.0.

### Fixed
- **OIDC-only auth gate:** the `preAction` hook no longer rejects commands when only an OIDC token is present (it previously hard-required an API key, blocking every CI push). Extracted to a tested `hasOidcAuth()` helper. (a4869fb)
- Drift-detection field mismatch, SIGTERM handler now re-raises after cleanup, oversized-blob skip, and the `target`/`--org` mutual-exclusion guard. (8d1653d)

### Notes for developers
- **Server compatibility:** the OIDC trust-binding + manifest-cap behaviour requires Margins server **v0.21.0+** (binding columns, `MAX_MANIFEST_FILES`, 2 MB blob cap). The CAS endpoints themselves work against v0.18.0+.
- `dist/` is build output (tracked today, rebuilt by `release.yaml` on publish). `bin/margins` is now gitignored — the tracked entrypoint is `bin/margins.js`.

## [0.6.0] - 2026-05-20

### Added
- **`margins install-hook`** — installs a non-blocking git hook that triggers a Margins sync on every `git push`. Default is `pre-push`; `--on commit` installs a `post-commit` hook instead. The hook runs `margins workspace push` in the background and never blocks `git`. Sync failures are logged but don't stop the push. (See README for full options + prerequisites.)
- **`margins workspace push` now reads `workspace_id` from `.margins.json`** when no `--workspace` or `--project` flag is passed. This makes the install-hook flow self-contained: after one `margins workspace push --workspace <id>` to record the workspace, the hook calls `margins workspace push` with no arguments and resolves the workspace from `.margins.json`. The `--workspace` flag still takes precedence.
- **CAS push-sync protocol** (`src/lib/cas-sync.ts`): replaces the old ingest-based push. Client hashes content locally, GETs the server manifest, diffs, uploads only changed blobs via `PUT /objects/:hash` (5 concurrent), then POSTs the new manifest. Works against Margins server v0.18.0+.
- **Image scanning** (`src/lib/image-scanner.ts`): finds image references in markdown via regex (svg/png/jpg/gif/webp) and includes them in the CAS push.
- **`.marginsignore` support** (`src/lib/marginsignore.ts`): gitignore-style patterns filter what gets uploaded. Purely client-side; the server never sees the file.
- **`ApiClient.putRaw()`** for raw binary blob uploads.

### Changed
- `LocalConfig` type gains `workspace_id?: string` so `.margins.json` can carry the workspace identifier the hook needs.
- Generated hook script now calls `margins workspace push` (not the non-existent `margins push`) and omits the `--branch` flag — `workspace push` detects the branch via `git rev-parse --abbrev-ref HEAD` internally.

### Fixed
- **`margins workspace push` no longer leaks `git` stderr on first-commit repos** — `gitParentSha()`, `gitBranch()`, and `gitCommitSha()` now set `stdio: ['ignore', 'pipe', 'ignore']` on the `execSync` calls so `git rev-parse HEAD~1`'s `fatal: ambiguous argument` message doesn't reach the user's terminal when there's no parent commit.
- **`install-hook` now warns when `.margins.json` is missing.** Without it the generated hook fails silently on every push. The warning points to `margins sync` to register the workspace.

### Notes for developers
- The pre-CAS `push.test.ts` (15 tests) was written against the old ingest endpoint and mocks only `client.post`. The new CAS push goes through `casSync()` which uses `get`/`putRaw`/`post`. Those tests are marked `describe.skip` with a `TODO(credentialless-sync)` comment pending a rewrite against the CAS protocol. Bug-fix coverage for this release is in two new test files: `__tests__/install-hook.test.ts` (5 tests) and `__tests__/push-margins-json.test.ts` (4 tests).
- Server-side compatibility: Margins server v0.18.0 introduced the CAS endpoints (`GET/POST /api/workspaces/:id/sync/manifest`, `PUT /api/workspaces/:id/sync/objects/:hash`). The `margins workspace push` flow requires v0.18.0+. The legacy `margins sync` top-level command still uses the v0.17.x `/ingest` endpoint and works against older servers.

## [0.5.1] - 2026-04-21

### Added
- `margins sync [dir]` top-level command for terminal and agent-driven folder setup
- Shared registry module (`src/lib/registry.ts`) with atomic writes (.tmp + rename)
- Git remote detection ported from Rust (`src/lib/detect-git-remote.ts`)
- Tests for registry and git remote detection

### Changed
- Extracted registry logic from `unsync.ts` into shared module

## [0.5.0] - 2026-04-20

### Added
- Published to npm registry (`@anthropic/margins-cli`)
- Global install documentation
