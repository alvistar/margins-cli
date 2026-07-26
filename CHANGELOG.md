# Changelog

All notable changes to margins-cli will be documented in this file.

## [0.18.0] - 2026-07-26

Responds to Margins server 0.60.0, which removed auto-join: `POST /api/workspaces`
now answers **409 `SLUG_CONFLICT`** when a workspace exists for the repo's slug and
the caller is not a member of it. The CLI read any 409 as "already exists, go find
it", and each command mishandled the refusal differently.

**Against an older server nothing changes.** Every branch below keys on the server's
structural error code, and a 409 without one keeps its previous behaviour exactly.

### Fixed
- **`margins sync` no longer creates a private workspace nobody asked for.** On a
  refusal it looked the workspace up through the membership-scoped listing, matched
  nothing (by construction, for a non-member), and fell through to creating a *local*
  workspace — pushing the repo's markdown somewhere nobody intended and pointing
  `.margins.json` at it. The only signal was a warning suppressed under `--json`, so
  in CI a refused sync looked like a successful one, and review comments could land
  in a workspace the author believed was their team's while being invisible to
  everyone. It now stops and shows the server's own message, which names the invite
  link. Because the top-level handler renders any thrown error through the JSON
  formatter, the refusal is visible under `--json` too, with a non-zero exit.
- **`margins install` no longer aborts a run over one inaccessible workspace.** The
  create had no handler at all: without `--org` the refusal reached the caller's
  rethrow and stopped every remaining repo; with `--org` it was recorded as a generic
  `failed`. It is now a per-repo `skipped` carrying the server's guidance — the same
  status the pipeline already uses for a workspace on the wrong sync mode.
- **`margins workspace create` no longer discards the server's guidance.** It rethrew
  a bare `Workspace already exists for <url>`, losing both the message and the code —
  so `SLUG_CONFLICT` ("ask an editor for an invite link") and `SYNC_MODE_CONFLICT`
  ("it uses a different sync mode") arrived as the same sentence despite needing
  different fixes. Both are preserved; the repo URL is added as context rather than
  replacing the message.
- **`margins sync` no longer binds a repo to a workspace that merely shares a name
  ending.** The lookup matched the *folder* basename against the tail of every slug,
  so a repo checked out into `docs/` matched `gh/someone/internal-docs` — a different
  owner and repo — and pushed to it. It now matches on repo identity, reusing the
  helper `margins install` already used correctly. The local-workspace lookup, which
  has no repo to match on, compares its slug's final segment exactly.

### Known gaps
- **`margins-sync-action` pins `MARGINS_CLI_VERSION`.** Publishing this release does
  not reach any workflow using the action until that pin is bumped, repo by repo.
  Treat the pin bump as part of shipping this, not as a follow-up.

## [0.17.0] - 2026-07-20

Requires a Margins server running 0.52.0 or later. Against an older server the
preflight carries no content mode, and the CLI behaves exactly as 0.16.0 did.

### Added
- **Committed content mode — sync the last commit instead of the working tree.**
  A workspace can now be set so a sync sends the tree of its last git commit rather
  than whatever is on disk. The file you are mid-sentence in stays yours until you
  commit it, which matters most for the background sync a post-commit hook fires.
  - **`margins workspace content-mode`** — read or change a workspace's mode. It
    shows what the switch will change *before* changing anything: how many files
    would be added, removed, or differ between the two views. The write is a
    compare-and-swap, so two people racing cannot both believe they won.
  - **`--content-mode` on `margins sync`** — settles the mode when a git repository is
    first set up for sync. Interactively the command asks; with no TTY or under
    `--json` it refuses rather than guessing, and the flag is how a script states the
    choice. (Distinct from `margins workspace sync`, which does not take the flag.)
  - **`--content-mode` on `workspace push`** — asserts the mode a push was collected
    under, and the push is refused if the workspace disagrees. The server likewise
    refuses a push that declares nothing rather than guessing, so an old CLI can never
    silently send a working tree to a workspace that asked for commits.
  - **Mode comes from the server on every push.** It is read from the sync preflight
    and never cached locally, so flipping a workspace takes effect on your next push
    instead of whenever your client happens to refresh.
- **Git provenance travels with a committed-mode push** — the git commit the tree was
  collected from is recorded alongside the content hash, as provenance only. Content
  hashes and git hashes stay in separate spaces.
- **A failed background sync is findable.** A sync fired by a git hook writes a
  failure record instead of dying silently, and the next foreground command surfaces
  it. Records are per-process and survive concurrent writers.

### Changed
- **Post-commit hook syncs the commit git actually named**, not whatever the working
  tree happens to be at the moment the hook runs. Previously a fast follow-up commit
  could race the hook and sync the wrong tree.

### Fixed
- **Committed mode refuses where it would quietly mislead** rather than sending a
  misleading tree: a repo with no commits, files that exist only in the working tree,
  and a checkout whose line endings genuinely differ from the index. That last check
  measures real divergence via `git ls-files --eol`; an earlier version keyed on
  `core.autocrlf`, which is a global setting on many machines and would have refused
  committed mode on every repo while proving nothing about the files.
- **Refusals apply correctly when syncing a subdirectory.** The line-ending and
  git-LFS checks ran from the repository root against sync-directory-relative paths,
  so they matched nothing and passed unconditionally — including on a real LFS
  pointer stub, which was collected as content.
- **A folder with a GitHub remote requests client sync**, so a credentialless CAS push
  is used instead of a server-side clone.
- **Server error messages survive a 403.** The CLI discarded the server's explanation
  and printed a generic "Access denied", hiding guidance that names the bound repo and
  how to proceed.
- **Large file lists no longer overflow the argument limit.** Path lists passed to git
  are chunked, so a sync of a big tree cannot fail with `E2BIG`.

## [0.16.0] - 2026-07-10

### Added
- **`margins stop`** — stop the detached Margins Light daemon that `margins open` starts. The
  launcher had always instructed users to run `margins stop`, but the command did not exist; the
  only way to end the daemon was `kill <pid>`. It reads `~/.margins/daemon.json`, SIGTERMs a live
  margins daemon (PID-recycle-safe: acts only when the discovery marker is ours and the PID is
  alive), and cleans up the discovery file; a stale/absent daemon is a graceful no-op.

### Fixed
- **`MARGINS_HOME` now isolates the store.** `margins open` passes the CLI-resolved store path to
  the daemon as `MARGINS_PGLITE`, so the store follows `MARGINS_HOME` instead of the runtime's
  hardcoded `~/.margins/store` default (which ignored `MARGINS_HOME`). Previously an isolated
  `MARGINS_HOME` (e.g. a throwaway test run) leaked its workspace into the shared `~/.margins/store`
  and desynced the U7 compat gate's recorded schema-head from the store the daemon actually migrated.

## [0.15.0] - 2026-07-09

### Added
- **`margins open <folder|file>` — Margins Light, local review.** Opens a local folder or
  Markdown file in a self-contained local Margins Light runtime: resolves + installs the private
  runtime npm package (`@alvistar/margins-light` from GitHub Packages), caches it under
  `~/.margins/runtime/<version>/`, and spawns the local daemon + reader — no Margins account
  needed. Disambiguates: an existing/`./`/`../`/`/` path routes local, a slug routes to the
  existing hosted open. Auth for the private runtime is a classic `read:packages` PAT via
  `MARGINS_RUNTIME_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`; the install is atomic +
  concurrency-safe and falls back to a cached runtime when the registry is unreachable.
- **`margins runtime list | which | clean`.** Manage the runtime cache — list cached versions +
  sizes (newest = active), name the active one, and prune all but the active. Installs also
  auto-prune to the active + previous version, so the cache can't grow unbounded.

## [0.14.0] - 2026-07-03

### Added
- **`--branch <branch>` on `margins workspace push`.** Overrides the auto-detected git
  branch. Needed in CI, where `actions/checkout` can leave a detached HEAD (so
  `git rev-parse --abbrev-ref HEAD` yields `HEAD`), and on the delete-event path where
  there is no checkout at all. Absent, `push` still detects the current git branch as before.
- **`margins workspace archive-branch --workspace <id> --branch <name>`.** Archives a
  workspace branch (hides it from the active branch list; the branch and its review
  discussions are retained and revived on the next push). Used by the sync Action's
  `delete`-event path when a git branch is deleted. Idempotent: an unknown or
  already-archived branch is a no-op, and the workspace's default branch is never archived.
  GitHub OIDC only — the server's archive endpoint rejects stored-key auth (403); this
  command is the sync Action's `delete`-event path, not a manual/local command.
- **`margins install` stamps a workflow that syncs every branch and archives on delete.**
  The stamped `.github/workflows/margins-sync.yml` drops the default-branch pin (every
  branch now matches the `paths` filter), adds a `delete:` trigger, and bumps its
  `schema-version` to `2`. Re-run `margins install` to adopt it; requires
  `alvistar/margins-sync-action@v1` at the matching schema version.

## [0.13.0] - 2026-07-03

### Added
- **`margins install` and `margins audit` detect the repo from `origin` when you don't pass one.**
  Running either command inside a repo clone with no `owner/repo` argument (and no `--org`) now
  resolves the target from the current repo's `origin` remote instead of erroring. `install` shows
  the detected repo and asks for confirmation before opening a PR; `audit` is read-only, so it just
  prints `Auditing owner/repo` and proceeds.
- **`--yes` flag on `margins install`.** Skips the confirmation prompt and accepts the
  origin-detected repo. Required when no repo is given in a non-interactive context (no TTY or
  `--json`), where `install` otherwise errors rather than open a PR against a guessed repo.

### Changed
- A non-GitHub `origin` (e.g. GitLab) or a missing remote now produces a clear, tailored error for
  `install` / `audit` ("... is not a GitHub repo") instead of the generic "specify a repo" message.

## [0.12.0] - 2026-07-02

### Added
- **Re-stashing a document now updates the same stash instead of creating a duplicate.**
  `margins stash <file>` remembers which stash a file was published to (a local
  file→stash binding), so running it again pushes the changed file back to the same
  stash via the server's new `PUT /api/stash` — the reader shows the update as a new
  version rather than forking a second doc. The binding lives per-account and is kept
  out of version control; a stale binding (the stash was deleted, or belongs to a
  different account) falls back to creating a fresh stash and rebinding.
- **`--new` and `--yes` flags on `margins stash`.** `--new` forces a fresh stash even
  when a binding exists (deliberately fork); `--yes` accepts a binding this machine did
  not itself record (for non-interactive/CI use) instead of prompting.

### Security
- **First-use trust gate on stash bindings.** A binding that this machine did not record
  (e.g. one committed into a cloned repo) is confirmed before it can redirect a re-stash,
  so a planted `.margins/stash-bindings.json` cannot silently overwrite a stash the caller
  happens to be able to edit. The binding store also refuses to follow a symlink at its
  path and keys acceptance on the full binding identity, not the slug alone.

### Changed
- **Graceful version-skew handling.** Against a server too old to support in-place updates
  (no `PUT /api/stash`), the CLI detects the `405` and falls back to creating a fresh stash
  rather than failing — so a new CLI against an old server degrades safely. `403` responses
  now carry the server's structured error code, so a comment-only reviewer is told to use
  `--new` instead of silently forking.

## [0.11.0] - 2026-06-27

### Added
- **`--confirm-full-delete` flag** on `margins workspace push` and `margins sync`.
  A push that would delete **every** file on the branch (an empty local tree
  against a populated branch) is now refused locally — nothing destructive is
  uploaded or committed — unless you pass `--confirm-full-delete`. This guards
  against an accidental wipe from the wrong directory or a dropped working tree.
  Mirrors the server's new `SYNC_FULL_DELETE_NOT_CONFIRMED` guard, so behaviour
  is identical whether or not the rejection comes from the server; a server-side
  rejection is mapped to the same actionable error. Partial deletes and pushes to
  an empty/new branch are unaffected.

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
