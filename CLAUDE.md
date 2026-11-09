# CLAUDE.md — margins-cli

## What this is

CLI for [Margins](https://margins.app) — review layer for Markdown in Git.
Published as a separate repo at `github.com/alvistar/margins-cli`.

## Versioning

`package.json` is the CLI's version — bump it on every release. The CLI is
published to npm; the npm registry is the canonical install path.

The **Claude Code plugin** that wraps this CLI no longer lives here. It moved to
the [`margins-plugins`](https://github.com/alvistar/margins-plugins) marketplace
repo and versions independently there (its own `plugin.json`).

The root `VERSION` file tracks the **margins web app**, not the CLI. Do not bump
it for CLI changes. It drives Flux image automation and GHCR tags.

All versions must use strict 3-segment semver (`MAJOR.MINOR.PATCH`).

## Build & run

```bash
npm install
npm run build          # tsdown → dist/index.mjs (ESM only)
npm run dev -- <args>  # run from source via tsx (no build needed)
```

Entry point: `src/index.ts` → built to `dist/index.mjs`.
Binary: `bin/margins.js` imports `../dist/index.mjs`.

## Testing

```bash
npm test               # vitest run
npm run test:watch     # watch mode
```

Tests live in `__tests__/`. Config: `vitest.config.ts` (node environment, no globals).

## Project structure

```
src/
  index.ts              # Commander program, subcommand registration, preAction auth hook
  commands/
    auth/               # login (Keycloak OAuth PKCE), logout, whoami
    config/             # set-key, set-url, show
    discuss/            # list, create, reply, resolve, wait (agent stream: claim one send), agent-action (reply/resolve --send, propose, progress, done)
    workspace/          # list, create, open, sync, push (push = CAS sync)
    install.ts          # Credentialless onboarding: workspace + OIDC binding + workflow PR
    audit.ts            # Sync-coverage report (missing/stale/drift/over-cap; --org, --csv)
    install-hook.ts     # git hook installer (non-blocking push/commit sync)
    sync.ts             # Top-level `sync` (folder setup + tray registry)
    sync-mode.ts        # `sync-mode push`: switch a pull workspace to push (no binding/workflow)
    completions.ts      # Shell completion script generation
  completions/
    dynamic.js          # Runtime completions (workspace slugs, discussion IDs)
  lib/
    agent-channel/      # protocol.ts (verbatim copy of the server's), SSE reader, `wait` reconnect loop, SQLite store (no secrets), actions.ts (outbox + Idempotency-Key resend), agent-key.ts (agent-keys.json, minted via the login), light-target.ts (the live Light daemon that holds a `local-` Workspace), mcp-config.ts (removes channel.mjs from the repo's .mcp.json)
    api-client.ts       # HTTP client; bearer resolver prefers OIDC over API key
    auth-env.ts         # hasOidcAuth() — OIDC token / mintable-env detection for the auth gate
    cas-sync.ts         # Content-addressable push protocol (manifest diff + blob upload)
    collect-sync-files.ts # Shared md+image collection pipeline with cap pre-check
    sync-mode.ts        # push/pull vocabulary: API client/server mapping, deprecated .margins.json aliases
    resolve-sync-mode.ts # syncMode resolution (.margins.json), legacy `mode` upgrade, detail read
    sync-mode-switch.ts # Switch to push: consequences, --yes/prompt gate, error mapping (install + sync-mode)
    repo-targets.ts     # Shared repo-target + org-glob expansion for install/audit
    audit-checks.ts     # Per-repo coverage checks used by `audit`
    config.ts           # Config resolution (env vars → stored config → defaults)
    errors.ts           # Error types (AuthMissing, ApiError, etc.)
    output.ts           # Formatting helpers (JSON/human output, error formatting)
    resolve-workspace.ts # .margins.json file discovery + workspace slug resolution
__tests__/              # Vitest tests mirroring src/ structure
```

## Adding a new command

1. Create handler in `src/commands/<group>/<action>.ts` — export a single
   `handle*` async function that takes `(cfg: ResolvedConfig, ...args)`.
2. Register in `src/index.ts` under the appropriate subcommand group using
   dynamic `import()` (keeps startup fast).
3. Support `cfg.json` for `--json` output and write errors to stderr.
4. Add tests in `__tests__/commands/`.

## Auth resolution

The `preAction` hook in `src/index.ts` gates commands on having *some* credential:
a stored/flag/env API key **or** an OIDC token (`hasOidcAuth()` in `lib/auth-env.ts`
checks `MARGINS_OIDC_TOKEN` or the mintable `ACTIONS_ID_TOKEN_REQUEST_*` pair). The
request-layer bearer resolver then prefers the OIDC token over the API key when both
are present. Commands in `NO_AUTH_COMMANDS` (`config`, `completions`, `help`, `auth`,
`install-hook`, `audit`, `open`, `runtime`, `stop`) skip the gate — `audit` is exempt so
it can run in gh-only mode; `workspace unsync` is exempt as a local-only subcommand. The
agent channel (`discuss wait`, the agent actions) also passes with no credential when
`liveDaemonAt` finds a live Light daemon at the server URL (#40). When the server URL is
not a live daemon and the agent-channel command's Workspace (`--workspace`, else the held
send's) is a `local-` id, the hook first sets `cfg.serverUrl` to the live daemon that holds it
(`resolveLightServer` in `light-target.ts`, which asks each daemon with the mint), so the
gate, the mint, the stream and the actions all reach that daemon (#67). A `wait` there follows
that daemon's store (`cfg.lightStore`) when it restarts on a new port, never minting on
another store's daemon at the old one (#72): `waitFollowingLight` in `discuss/wait.ts` retries
the picked daemon with backoff while it does not answer yet (one stderr line), and
`findLightServerAgain` drops the old URL's agent key on every move. An action given only a
`--send` the local store lacks, with a live daemon, fails with the unknown-send error before
the gate, never `margins auth login` (#68).

One request carries neither: the agent key mint against a Margins Light daemon
(`agent-key.ts`) sends the daemon's capability token in `x-margins-token` and no
`Authorization` (`fixedBearer: null`). It is chosen when a live discovery record in
`~/.margins/daemons/` names the server URL's loopback port (`liveDaemonAt` in `runtime.ts`).

## Claude Code plugin

The Claude Code plugin that wraps this CLI (skills `margins`, `margins-read`,
`margins-setup`) moved to the
[`margins-plugins`](https://github.com/alvistar/margins-plugins) marketplace repo.
Install it from there; this repo ships the npm CLI only.

These skills are designed to be installed into Claude Code via the plugin system.

## No production requests

Every command that talks to a Margins server names a local one explicitly (`MARGINS_SERVER_URL` or `--server-url`). Left on its default, the CLI reaches production: on 2026-10-22 a ship's smoke probe sent an agent-key mint there. No request of any kind goes to margins.thealvistar.com from an agent session unless the owner asks for that probe in this session. The hard stop is the owner's `.claude/settings.local.json`, copied into every worktree by `.worktreeinclude`.
