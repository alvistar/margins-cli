---
name: margins-setup
description: |
  Install the Margins CLI globally and configure authentication.
  Use when: "margins setup", "setup margins", "configure margins",
  or when /margins or /margins-read fails with "margins CLI not found".
---

# /margins-setup — Install and Configure Margins CLI

## Step 1: Check if margins CLI is already installed

```bash
command -v margins && margins --version
```

If the CLI is found, skip to Step 3 (credential check).

## Step 2: Verify margins CLI is accessible via npx

The margins CLI is published to npm and invoked through npx. No global install needed.

```bash
npx --yes margins-cli --version
```

For a persistent install: `npm install -g margins-cli`.

If `npx` is not found, tell the user:
> "Node.js is required. Install it from https://nodejs.org, then retry `/margins-setup`."

If the version check succeeds, the CLI is ready to use.

## Step 3: Check for existing credentials

```bash
margins config show
```

If credentials exist (API key or OAuth tokens shown), skip to Step 5 (verification).

## Step 4: Configure authentication

Ask the user via AskUserQuestion:

> "How would you like to authenticate with Margins?"

Options:
- **OAuth login** — Opens your browser for Keycloak SSO login (recommended for interactive use)
- **API key** — Paste a static API key (recommended for CI/scripts)

### If OAuth login

```bash
margins auth login
```

This opens a browser window for Keycloak authentication. The CLI starts a local HTTP server to receive the callback. Wait for the user to complete the browser flow.

If it fails with "invalid redirect_uri", the Keycloak client may not have localhost registered. Tell the user:
> "Keycloak needs `http://localhost:*` registered as a redirect URI. Ask your admin to add it."

### If API key

Ask: "Paste your Margins API key (starts with `mrgn_`):"

```bash
margins config set-key <key>
```

## Step 5: Verify authentication

```bash
margins auth whoami
```

If successful, show the result and confirm:
> "Margins CLI installed and authenticated. You can now use `/margins` and `/margins-read`."

If it fails, surface the error and suggest:
> "Authentication verification failed. Try running `margins auth login` again."

## Onboarding a repo to continuous / CI sync (optional)

Once authenticated, two commands set up ongoing sync:

- `margins install [target]` — onboard a repo to **credentialless** sync: creates
  the workspace, writes the OIDC trust binding, and opens a workflow PR so a
  GitHub Action pushes markdown with no stored API key. Use `--org <org>` (with
  `--include`/`--exclude` globs) to onboard every repo in an org, and `--dry-run`
  to preview. This is the recommended path for CI / org-wide adoption.
- `margins audit [target]` — report sync coverage across repos: missing workflows,
  stale action pins, binding drift, and over-cap repos (`--org`, `--csv`). Runs in
  gh-only mode without margins credentials (drift checks are skipped).

For a single developer who just wants their local edits reviewed, `/margins push`
(no setup beyond auth) is enough — `install` is for the CI/automated path.
