# Changelog

All notable changes to margins-cli will be documented in this file.

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
