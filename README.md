# margins-cli

CLI for [Margins](https://margins.app) — review layer for Markdown in Git.

Margins is a review platform where humans and AI agents are equal participants. It renders Markdown files from a Git repository in a clean UI where reviewers can open discussions, propose changes, and approve content. `margins-cli` exposes every Margins action as a shell command, making it usable in scripts, CI pipelines, and by AI agents.

## Installation

`margins-cli` lives at [github.com/alvistar/margins-cli](https://github.com/alvistar/margins-cli).

**Run without installing (recommended):**

```sh
npx github:alvistar/margins-cli <command>
```

No token, no registry setup — works anywhere you have Node.js and Git installed,
including CI pipelines and AI agent environments.

**Install globally:**

```sh
npm install -g github:alvistar/margins-cli
```

**Or clone and build locally:**

```sh
git clone https://github.com/alvistar/margins-cli.git
cd margins-cli
npm install && npm run build
npm link   # makes 'margins' available globally
```

## Quick Start

```sh
# Log in via browser (one-time)
margins auth login

# See your workspaces
margins workspace list

# Push local markdown to a brand-new workspace (no GitHub repo needed)
margins workspace push --project my-docs --dir ./docs

# List open discussions in the current repo
margins discuss list

# Create a discussion on a file
margins discuss create --path docs/intro.md --body "This section needs a concrete example."
```

## Authentication

Two methods are supported. The active credential is resolved in priority order:

| Priority | Source | Set by |
|---|---|---|
| 1 | `--api-key <key>` flag | any command |
| 2 | `MARGINS_API_KEY` env var | shell / CI environment |
| 3 | Stored static API key | `margins config set-key` |
| 4 | Stored Keycloak access token | `margins auth login` |

### Browser login (recommended for humans)

```sh
margins auth login
```

Opens your browser to complete OAuth 2 PKCE against Keycloak. On success, the access token and refresh token are stored locally. The token is refreshed automatically before it expires — no re-login needed.

### Static API key (recommended for CI / agents)

Mint a key from the Margins web UI or the API (`POST /api/keys`), then store it:

```sh
margins config set-key mrgn_...
# or per-invocation:
margins --api-key mrgn_... workspace list
# or via environment:
MARGINS_API_KEY=mrgn_... margins workspace list
```

Static keys support two scopes: `comment` (read + create discussions) and `edit` (full write access).

---

## Commands

### Global Flags

Available on every command.

| Flag | Description |
|---|---|
| `-v, --version` | Print version and exit |
| `--json` | Output as JSON — for scripting and agents |
| `--verbose` | Enable debug logging |
| `--no-color` | Disable ANSI colors |
| `--server-url <url>` | Override the server URL (default: `https://margins.app`) |
| `--api-key <key>` | Override the API key for this invocation |

---

### `config`

Manage local CLI configuration.

#### `config show`

Display the active configuration.

```sh
margins config show
margins config show --json
```

Shows the active server URL, the masked API key or token, and whether auth came from `auth login` or `config set-key`.

#### `config set-key <key>`

Store a static Margins API key.

```sh
margins config set-key mrgn_abc123...
```

Saves the key to the global config file. Clears any previously stored Keycloak session.

#### `config set-url <url>`

Override the server URL (useful for self-hosted Margins instances).

```sh
margins config set-url https://margins.example.com
```

---

### `auth`

Authentication commands.

#### `auth login`

Log in via browser using Keycloak OAuth 2 + PKCE.

```sh
margins auth login
```

Opens a browser window to complete the OAuth flow. On completion, stores the Keycloak access token and refresh token locally. Subsequent commands use the token automatically, refreshing it transparently when it expires.

> **Note:** The Keycloak client must have `http://localhost:*` registered as a valid redirect URI. See [TODOS.md](../TODOS.md) for the Keycloak admin configuration step.

#### `auth whoami`

Show the currently authenticated identity.

```sh
margins auth whoami
margins auth whoami --json
```

Calls `GET /api/auth/whoami` and displays your user ID, email, and role.

#### `auth logout`

Revoke the stored session and clear local credentials.

```sh
margins auth logout
```

Revokes the Keycloak refresh token and clears the stored access/refresh tokens from the config file. The server URL is preserved.

---

### `workspace`

Manage Margins workspaces. A workspace is the unit of review in Margins. There are two kinds:

- **GitHub workspaces** — connect a GitHub repository. Margins clones the repo and syncs markdown files on demand. Created with `workspace create <repo-url>`.
- **Local workspaces** — no repository. You push markdown files directly via `workspace push --project <name>`. Useful for solo work, drafts, or content that does not live in a Git repo yet.

You can also push local markdown into a GitHub workspace via `workspace push --workspace <id>` — the content lands on a virtual `@local` branch alongside the real git branches, so you can review uncommitted edits before pushing them upstream.

#### `workspace list`

List all workspaces you have access to.

```sh
margins workspace list
margins workspace list --json
```

Displays workspace slug, name, sync status, and last synced time.

#### `workspace create <repo-url>`

Create a new workspace from a GitHub repository URL.

```sh
margins workspace create https://github.com/org/repo
```

If a workspace for that repository already exists and you are not a member, you will be auto-joined to it.

#### `workspace open [slug]`

Open a workspace in the browser.

```sh
margins workspace open           # uses slug from .margins.json
margins workspace open my-repo
```

If no slug is provided, reads `workspace_slug` from `.margins.json` in the current directory (or any parent).

#### `workspace sync [slug]`

Trigger a git sync to pull the latest content from the repository.

```sh
margins workspace sync                      # uses .margins.json
margins workspace sync my-repo
margins workspace sync my-repo --branch main
```

| Flag | Description |
|---|---|
| `--branch <branch>` | Branch to sync (defaults to the workspace's default branch) |

> Local workspaces cannot be synced this way — they receive content via
> `workspace push`. Calling `sync` on a local workspace returns
> `LOCAL_SYNC_NOT_SUPPORTED` (HTTP 422).

#### `workspace push`

Push local markdown files to a workspace for review. This is the only way to
get content into a **local workspace**, and the way to overlay uncommitted
edits onto a **GitHub workspace** via the virtual `@local` branch.

```sh
# Create a brand-new local workspace and push files in one step
margins workspace push --project my-docs --dir ./docs

# Push more files to the same workspace later (re-use the workspace ID)
margins workspace push --workspace 0cfbdc14-c023-4c84-bc4a-e027e13cefab --dir ./docs

# Overlay local edits onto an existing GitHub workspace (lands on @local branch)
margins workspace push --workspace <github-workspace-id> --dir ./docs
```

| Flag | Required | Description |
|---|---|---|
| `--project <name>` | one of | Create a new local workspace with this name. Slug becomes `local/<your-username>/<name>`. The name must be alphanumeric (hyphens, dots, underscores allowed). |
| `--workspace <id>` | one of | Push to an existing workspace by UUID. Use this for re-pushes and for pushing into GitHub workspaces. |
| `--dir <path>` | no | Directory to recursively scan for `.md` files. Defaults to the current directory. Hidden files, `node_modules/`, and symlinks are skipped. |

**Behavior:**
- Recursively scans `--dir` for `.md` files (max 50 per push, max 1 MB per file, max 10 MB total)
- For each file, computes a SHA-256 hash of the content. If the hash matches an existing artifact, the file is **skipped**. Otherwise it is **added** or **changed**.
- Output (with `--json`):
  ```json
  { "added": 2, "changed": 0, "skipped": 0 }
  ```
- For local workspaces, content lands on the `main` branch.
- For GitHub workspaces, content lands on the virtual `@local` branch — visible in the branch switcher alongside real git branches, but never pushed upstream.

**Example: review your local edits before committing them**

```sh
cd ~/my-project                               # has docs/spec.md, README.md
margins workspace push --workspace <gh-ws-id> # uploads to @local
margins workspace open                         # opens browser, switch to @local branch
# ...review, comment, refine...
git commit -am "Refine spec"                  # then commit for real
margins workspace sync                         # pull the committed version into main
```

---

### `discuss`

Manage discussions on Markdown artifacts.

#### `discuss list [slug]`

List discussions in a workspace.

```sh
margins discuss list                     # uses .margins.json, shows open discussions
margins discuss list my-repo
margins discuss list my-repo --status resolved
margins discuss list my-repo --path docs/intro.md
margins discuss list --json
```

| Flag | Description | Default |
|---|---|---|
| `--path <path>` | Filter by artifact path | — |
| `--status <status>` | Filter by status: `open` or `resolved` | `open` |

#### `discuss create [slug]`

Create a new discussion on an artifact.

```sh
margins discuss create \
  --path docs/intro.md \
  --body "This section needs a concrete example."

margins discuss create my-repo \
  --path docs/api.md \
  --body "Consider adding a rate limit note here." \
  --anchor-heading "Authentication"

margins discuss create my-repo \
  --path docs/api.md \
  --body "Typo: 'recieve' should be 'receive'." \
  --anchor-text "recieve the response"
```

| Flag | Required | Description |
|---|---|---|
| `--path <path>` | yes | Artifact path within the workspace |
| `--body <body>` | yes | Discussion body text |
| `--anchor-heading <heading>` | no | Anchor the discussion to a heading |
| `--anchor-text <text>` | no | Anchor the discussion to a text selection |

#### `discuss reply <discussion-id>`

Post a reply to an existing discussion.

```sh
margins discuss reply d_abc123 --body "Fixed in the latest commit."
margins discuss reply d_abc123 --body "Agreed." --workspace my-repo
```

| Flag | Required | Description |
|---|---|---|
| `--body <body>` | yes | Reply body text |
| `--workspace <slug>` | no | Workspace slug (alternative to `.margins.json`) |

#### `discuss resolve <discussion-id>`

Mark a discussion as resolved.

```sh
margins discuss resolve d_abc123
margins discuss resolve d_abc123 --summary "Updated the docs to include this example."
margins discuss resolve d_abc123 --workspace my-repo
```

| Flag | Required | Description |
|---|---|---|
| `--summary <summary>` | no | Short description of how the issue was resolved |
| `--workspace <slug>` | no | Workspace slug (alternative to `.margins.json`) |

---

### `completions`

Generate shell completion scripts.

```sh
margins completions -s zsh   # zsh
margins completions -s bash  # bash
margins completions -s fish  # fish
```

| Flag | Required | Description |
|---|---|---|
| `-s, --shell <shell>` | yes | Target shell: `bash`, `zsh`, or `fish` |

#### Install

**Zsh** — add to `~/.zshrc`:
```sh
eval "$(margins completions -s zsh)"
```

**Bash** — add to `~/.bashrc` or `~/.bash_profile`:
```sh
eval "$(margins completions -s bash)"
```

**Fish** — add to `~/.config/fish/config.fish`:
```fish
margins completions -s fish | source
```

After reloading your shell, press `Tab` after `margins workspace sync ` to get live workspace slug completion from the API.

---

## Agent / Scripting Mode

All commands support `--json` for structured output:

```sh
margins workspace list --json
# → [{ "slug": "my-repo", "name": "My Repo", "syncStatus": "synced", ... }]

margins discuss list my-repo --json
# → [{ "id": "d_...", "path": "docs/intro.md", "body": "...", "status": "open", ... }]
```

For non-interactive use (CI, agents), use environment variables instead of stored credentials:

```sh
MARGINS_API_KEY=mrgn_... MARGINS_SERVER_URL=https://margins.example.com margins workspace list --json
```

**Exit codes:** `0` on success, `1` on any error (auth failure, network error, not found, etc.). Error details are written to stderr.

---

## Local Workspace Config (`.margins.json`)

When a slug argument is omitted, the CLI walks up from the current directory looking for a `.margins.json` file. This allows running commands from anywhere inside a repository without repeating the workspace slug.

Example `.margins.json`:

```json
{
  "workspace_slug": "local/avigano/my-docs",
  "workspace_id": "0cfbdc14-c023-4c84-bc4a-e027e13cefab",
  "default_branch": "main",
  "mode": "local",
  "server_url": "https://margins.example.com"
}
```

| Field | Description |
|---|---|
| `workspace_slug` | Default workspace slug for `discuss` and `workspace` commands |
| `workspace_id` | Default workspace UUID. Used by `workspace push --workspace` for re-pushes — more reliable than slug because it doesn't depend on slug resolution. |
| `default_branch` | Default branch for `workspace sync`. For local workspaces this is `main`; for GitHub-overlay mode (local edits pushed to a GitHub workspace's `@local` branch) this is `@local`. |
| `mode` | `"local"` for local workspaces, `"github-overlay"` for local edits overlaid on a GitHub workspace via the `@local` virtual branch. Used by skills to decide push behavior on subsequent runs. Optional; absence implies `"local"`. |
| `server_url` | Server URL override (lower priority than `--server-url` and `MARGINS_SERVER_URL`) |

> **Project-scoped credentials:** `.margins.json` is intended to be committed to the
> repository so teammates share the same workspace identity. It does NOT contain
> credentials. For project-scoped API keys + server URL, use a `.margins/` directory
> at the project root containing `config.json` and set `MARGINS_CONFIG_DIR` to point
> at it. Add `.margins/` to `.gitignore` since it contains credentials.

---

## Global Config File

The CLI resolves the config directory in this order:

| Priority | Condition | Path used |
|---|---|---|
| 1 | `MARGINS_CONFIG_DIR` env var is set | `$MARGINS_CONFIG_DIR/config.json` |
| 2 | `~/.config/margins/config.json` already exists | `~/.config/margins/config.json` |
| 3 | Platform default (fallback) | macOS: `~/Library/Preferences/margins/config.json` · Linux/XDG: `~/.config/margins/config.json` · Windows: `%APPDATA%/margins/Config/config.json` |

**Preferred location on all platforms:** `~/.config/margins/config.json`

If that file exists (e.g. you created it manually, or you're on Linux), it takes precedence over the macOS `~/Library/Preferences/` default. To migrate on macOS:

```sh
mkdir -p ~/.config/margins
cp ~/Library/Preferences/margins/config.json ~/.config/margins/config.json
```

The `MARGINS_CONFIG_DIR` override is intended for tests and CI — it fully isolates the config from your user profile.

| Field | Set by | Description |
|---|---|---|
| `apiKey` | `config set-key` | Static Margins API key (`mrgn_...`) |
| `serverUrl` | `config set-url` | Server URL override |
| `accessToken` | `auth login` | Keycloak JWT access token |
| `refreshToken` | `auth login` | Keycloak refresh token (auto-refresh) |
| `accessTokenExpiresAt` | `auth login` | Access token expiry (epoch ms) |
| `keycloakIssuer` | `auth login` | Keycloak realm URL |
| `keycloakClientId` | `auth login` | Keycloak client ID |

> Running `margins auth login` clears any previously stored `apiKey`. Running `margins config set-key` clears any stored Keycloak session.

---

## Development

```sh
git clone https://github.com/alvistar/margins-cli.git
cd margins-cli
npm install

# Build
npm run build          # compiles to dist/index.mjs via tsdown

# Run from source (no build required)
npm run dev -- workspace list

# Tests
npm test               # vitest run (114 tests)
npm run test:watch     # watch mode
```

The CLI is built as ESM. The `bin/margins.js` shebang entry imports `../dist/index.mjs`.

> **How `npx github:alvistar/margins-cli` works:** npm clones the repo, runs
> `npm install`, then runs the `prepare` script (`npm run build`) automatically.
> This compiles `src/` to `dist/` before the binary is executed — no pre-built
> files need to be committed.




