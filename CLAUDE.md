# CLAUDE.md — margins-cli

## What this is

CLI for [Margins](https://margins.app) — review layer for Markdown in Git.
Published as a separate repo at `github.com/alvistar/margins-cli`.

## Versioning

**CLI and plugin share one version.** `package.json` and
`margins-plugin/.claude-plugin/plugin.json` must always have the same version.
Bump both together on every release, whether the change is CLI code, skill
content, or both. Claude Code uses `plugin.json` version for cache invalidation,
so a skill-only change still needs a version bump to reach users.

The root `VERSION` file tracks the **margins web app**, not the CLI. Do not bump
it for CLI or skill changes. It drives Flux image automation and GHCR tags.

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
    discuss/            # list, create, reply, resolve
    workspace/          # list, create, open, sync, push
    completions.ts      # Shell completion script generation
  completions/
    dynamic.js          # Runtime completions (workspace slugs, discussion IDs)
  lib/
    api-client.ts       # HTTP client for Margins API
    config.ts           # Config resolution (env vars → stored config → defaults)
    errors.ts           # Error types (AuthMissing, ApiError, etc.)
    output.ts           # Formatting helpers (JSON/human output, error formatting)
    resolve-workspace.ts # .margins.json file discovery + workspace slug resolution
__tests__/              # Vitest tests mirroring src/ structure
margins-plugin/
  skills/               # Claude Code skills (margins, margins-read, margins-setup)
```

## Adding a new command

1. Create handler in `src/commands/<group>/<action>.ts` — export a single
   `handle*` async function that takes `(cfg: ResolvedConfig, ...args)`.
2. Register in `src/index.ts` under the appropriate subcommand group using
   dynamic `import()` (keeps startup fast).
3. Support `cfg.json` for `--json` output and write errors to stderr.
4. Add tests in `__tests__/commands/`.

## Auth resolution

The `preAction` hook in `src/index.ts` resolves credentials in priority order:
`--api-key` flag → `MARGINS_API_KEY` env → stored API key → stored Keycloak token.
Commands in `NO_AUTH_COMMANDS` (`config`, `completions`, `help`, `auth`) skip this.

## Plugin / Skills

`margins-plugin/skills/` contains Claude Code skills that wrap CLI commands:
- `margins` — full review workflow (push + discuss)
- `margins-read` — read-only workspace access
- `margins-setup` — workspace setup and auth

These skills are designed to be installed into Claude Code via the plugin system.
