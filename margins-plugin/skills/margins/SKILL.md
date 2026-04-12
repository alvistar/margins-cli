---
name: margins
description: |
  The write skill for the Margins review platform. Two workflows in one:

  **Push workflow** — Upload local markdown files to Margins for human review.
  Creates a workspace if needed (local-only or as a virtual @local branch on an
  existing GitHub workspace), pushes every .md file in the project, and prints the
  review URL. Use when the user wants to:
  - Get human review of local markdown drafts ("review on margins", "/margins push", "let's review on margins")
  - Upload uncommitted markdown edits for pre-commit review
  - Re-push markdown files after making changes

  **Discuss workflow** — Post a discussion to Margins anchored to a specific file.
  Creates the workspace automatically if it doesn't exist (1 workspace per repo).
  Infers which file and anchor point to use from the topic and conversation context.
  If no relevant file exists, creates openspec/decisions/<slug>.md with context first.
  Use when the user wants to:
  - Flag a decision for team discussion ("post this to Margins", "/margins discuss <topic>")
  - Get async human input on an architecture or design choice
  - Record a decision point that needs team sign-off
  - Start a threaded discussion anchored to a specific file/section

  To read comments back from the workspace, use /margins-read.
---

# /margins — Write to Margins (Push or Discuss)

## Preamble: resolve binary, project config, and existing workspace

```bash
# 1. Resolve the margins binary. Order matters: prefer local builds (likely
# newer than the published GitHub version) before falling back to npx.
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$_ROOT" ] && [ -f "$_ROOT/margins-cli/bin/margins.js" ]; then
  MARGINS="node $_ROOT/margins-cli/bin/margins.js"
elif command -v margins &>/dev/null; then
  MARGINS="margins"
elif [ -x "$HOME/.bun/bin/margins" ]; then
  # bun link install location — needed when ~/.bun/bin is not in $PATH
  # (e.g. bun installed via Homebrew, or non-interactive subshells)
  MARGINS="$HOME/.bun/bin/margins"
else
  MARGINS="npx --yes github:alvistar/margins-cli"
fi

# 2. Project-scoped CLI config: if .margins/ exists at the git root, use it.
# This isolates serverUrl + apiKey per-project so localhost dev and prod don't collide.
if [ -n "$_ROOT" ] && [ -d "$_ROOT/.margins" ]; then
  export MARGINS_CONFIG_DIR="$_ROOT/.margins"
fi

# 3. Walk up looking for .margins.json (existing workspace identity)
SLUG=""
WORKSPACE_ID=""
MODE=""
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  if [ -f "$DIR/.margins.json" ]; then
    SLUG=$(jq -r '.workspace_slug // empty' "$DIR/.margins.json")
    WORKSPACE_ID=$(jq -r '.workspace_id // empty' "$DIR/.margins.json")
    MODE=$(jq -r '.mode // "local"' "$DIR/.margins.json")
    PROJECT_ROOT="$DIR"
    break
  fi
  DIR=$(dirname "$DIR")
done

# Project root falls back to git root or cwd if no .margins.json found
PROJECT_ROOT="${PROJECT_ROOT:-${_ROOT:-$PWD}}"
```

Use `$MARGINS` for every command below. If `npx` is unavailable, tell the user:
> "Node.js is required. Install it from https://nodejs.org, then retry."

## Intent Router

Determine which workflow to run based on the user's message and `$ARGUMENTS`:

**Push workflow** — activates when the intent is about LOCAL/UNCOMMITTED content:
- Explicit: `/margins push` or `/margins review`
- Implicit: message mentions "push files", "review before committing", "put this on margins for review", "get eyes on these docs"
- Context: Claude has created/edited local `.md` files in this conversation and user asks for review

**Discuss workflow** — activates when the intent is about a DECISION or QUESTION on existing repo content:
- Explicit: `/margins discuss <topic>` or `/margins <topic>`
- Implicit: message mentions "flag this", "post a discussion", "get team input on", "need sign-off"

**Disambiguation:** If both could apply, check whether the user is referencing local uncommitted files (push) or existing repo content (discuss). If still unclear, ask:
> "Do you want to push local files for review, or start a discussion on an existing file?"

---

## Push Workflow

### Step P1: Decide push mode

Three possibilities, in priority order:

#### Mode A: Re-push (workspace already exists)

If `$WORKSPACE_ID` is non-empty (the preamble found a `.margins.json`), this is a re-push. Skip directly to Step P3.

#### Mode B: First-time GitHub overlay

Else if `git remote get-url origin` returns a GitHub URL, ask the user via AskUserQuestion:

> **This project has a GitHub remote.** How should I handle the markdown upload?
>
> A) **Overlay onto the existing GitHub workspace's `@local` branch** (recommended) — your local edits show up alongside the committed version, you can review uncommitted changes before pushing them upstream
> B) **Create a separate local-only workspace** — completely independent from the GitHub workspace, useful for drafts that don't belong in the repo

If A:
1. Derive the github slug from the remote URL (`https://github.com/owner/repo` -> `gh/owner/repo`)
2. Look up the workspace ID via `$MARGINS workspace list --json | jq -r '.[] | select(.slug == "<derived-slug>") | .id'`
3. If not found, create it: `$MARGINS workspace create "$REPO_URL"` then re-list to capture the ID
4. Set `MODE="github-overlay"`, `DEFAULT_BRANCH="@local"`
5. Continue to Step P2

If B: fall through to Mode C below.

#### Mode C: First-time local

No `.margins.json`, no usable github remote (or user picked B above). Create a brand-new local workspace:

1. Derive `PROJECT_NAME` from `basename "$PROJECT_ROOT"` (or `basename "$PWD"` if no git root):
   ```bash
   PROJECT_NAME=$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/--*/-/g; s/^-*//; s/-*$//')
   ```
   This sanitizes to match the server's `[a-z0-9][a-z0-9_.-]*` regex on `projectName`.

2. If sanitization produces an empty string (e.g. directory name was all special chars), ask the user for a project name.

3. Set `MODE="local"`, `DEFAULT_BRANCH="main"`. Continue to Step P2.

### Step P2: First-time push (Mode B or C)

For **Mode C (local)**:
```bash
$MARGINS workspace push --project "$PROJECT_NAME" --dir "$PROJECT_ROOT" --json
```

For **Mode B (github-overlay)**:
```bash
$MARGINS workspace push --workspace "$WORKSPACE_ID" --dir "$PROJECT_ROOT" --json
```

Capture the JSON output. For Mode C with `--json`, the CLI outputs two JSON lines:
1. `{ "created": true, "workspaceId": "<uuid>", "slug": "<slug>" }` (workspace creation)
2. `{ "added": N, "changed": N, "skipped": N, "workspaceId": "<uuid>", "slug": "<slug>" }` (push result with workspace metadata)

Parse either line for `workspaceId` and `slug`. Capture `added`, `changed`, `skipped` from the second line.

For Mode C, capture `slug` and `id` into `$SLUG` and `$WORKSPACE_ID`.

Then **persist `.margins.json`** at `$PROJECT_ROOT`:
```json
{
  "workspace_slug": "<slug>",
  "workspace_id": "<uuid>",
  "default_branch": "<main or @local>",
  "mode": "<local or github-overlay>"
}
```

Skip writing `.margins.json` if it already exists (defensive).

Note: `.margins.json` is intended to be committed to the repo so teammates share the same workspace identity. It contains no credentials.

### Step P3: Re-push (Mode A) or finalization

For **Mode A (re-push)**:
```bash
$MARGINS workspace push --workspace "$WORKSPACE_ID" --dir "$PROJECT_ROOT" --json
```

Capture the `{added, changed, skipped}` counts.

### Step P4: Show the result

Print a single block to the user:

```
Pushed: <added> added, <changed> changed, <skipped> skipped
Workspace: <serverUrl>/w/<slug>/-/<default_branch>/

Click the URL to review in your browser. When you're done leaving
comments, run /margins-read to fetch them back.
```

Where `<serverUrl>` comes from `margins config show --json | jq -r '.serverUrl'` (respects the project-scoped `MARGINS_CONFIG_DIR` set in the preamble).

For first-time runs in Mode C, also tell the user:
> Created `.margins.json` at `<project_root>`. This file is safe to commit — it lets teammates share the same workspace.

### Push error paths

- **`$MARGINS workspace push` returns 401**: API key missing or invalid. Tell the user:
  > "Auth failed. Run `margins auth login`, or set up project-scoped credentials by creating `<project_root>/.margins/config.json` with `{serverUrl, apiKey}`."

- **413 Payload Too Large** (more than 50 files or >10MB total): Tell the user to scope the push:
  > "Too many markdown files in this directory. Re-run with a narrower scope, e.g.: `/margins push docs/` (or split the project into smaller workspaces)."
  Accept an optional `$ARGUMENTS` value as a subdirectory hint.

- **400 with "Invalid file path"**: A file has a path the server's validator rejects (`..`, absolute path, non-`.md`, etc.). Identify the offending file from the error message and tell the user.

- **400 with "projectName must be alphanumeric"**: Sanitization failed. Re-run with a manually-supplied project name or ask the user to provide one.

- **Network error**: server unreachable. Check `$MARGINS config show` to confirm `serverUrl`. If pointing at localhost, check the dev server is running on the configured port.

### Push notes

- This skill never deletes artifacts. To remove a file from the workspace, delete it from the project directory and re-push — but currently the server is additive-only, so deleted local files will continue to show in the workspace until manually cleaned up.

- `MARGINS_CONFIG_DIR` makes the CLI fully ignore the global `~/.config/margins/config.json` for the duration of this skill's invocation. If the user has a global config, it stays untouched.

- Hidden files, `node_modules/`, and symlinks are skipped by `workspace push` automatically.

---

## Discuss Workflow

### Step D1: Confirm workspace slug

If `$SLUG` is already populated from `.margins.json`, **skip the git-remote derivation entirely** and use that slug. Jump to Step D3.

Otherwise (no `.margins.json`), fall back to git-remote derivation:

```bash
REPO_URL=$(git remote get-url origin 2>/dev/null)
```

If empty, tell the user:
> "No `.margins.json` found and no git remote configured. Run `/margins push` first to create a workspace, or set up a GitHub/GitLab remote."

And stop.

Normalize SSH to HTTPS:
- `git@github.com:owner/repo.git` -> `https://github.com/owner/repo`
- `git@gitlab.com:owner/repo.git` -> `https://gitlab.com/owner/repo`
- Strip trailing `.git` if present

Derive the workspace slug (mirrors the server's `parseSlug()` logic):
- GitHub: `https://github.com/owner/repo` -> `gh/owner/repo`
- GitLab: `https://gitlab.com/owner/repo` -> `gl/owner/repo`
- Other: use `<host-without-tld>/<owner>/<repo>`

### Step D2: Ensure workspace exists

Skip this step if `$SLUG` came from `.margins.json` (the workspace already exists, that's how it got into `.margins.json`).

Otherwise:

```bash
$MARGINS workspace create "$REPO_URL" 2>&1
```

- If it succeeds -> workspace created, slug is confirmed
- If it exits with a conflict error (workspace already exists) -> proceed with derived slug
- If it fails for any other reason -> surface the error and stop

If the command fails with an auth error, tell the user:
> "Run `$MARGINS auth login` first, then retry `/margins`."

### Step D3: Infer target file and anchor

From `$ARGUMENTS` (the topic) and conversation context, choose the best file to anchor the discussion to.

**Priority order:**
1. A file being actively discussed in conversation (spec, brief, source file)
2. The most relevant openspec file: `openspec/changes/<active-change>/brief.md`, a `spec.md`, or `decisions.md`
3. A source file clearly related to the topic (e.g., if the topic is about auth, look at auth-related files)
4. If nothing fits -> create a new decision document (Step D3b)

**Choosing the anchor:**
- Scan the target file for the most relevant heading. Use `--anchor-heading "<heading text>"`.
- If no heading fits but a specific text excerpt is relevant, use `--anchor-text "<quoted snippet>"`.
- If the file has no obvious anchor point, omit both flags (discussion attaches to the document root).

#### Step D3b: Create a decision document (when no file fits)

Derive a slug from the topic: lowercase, hyphens, max 40 chars.

Create `openspec/decisions/<slug>.md`:

```markdown
# <Topic>

> Created by /margins on <date> for async team discussion.

## Context

<1-3 sentence summary of the situation from conversation context>

## The Question

<What decision or input is needed from the team>

## Options Considered

<Bullet list of the options discussed, if any — omit section if none>
```

Commit the file:
```bash
git add openspec/decisions/<slug>.md
git commit -m "docs: add decision doc for team discussion — <slug>"
```

Use this file as the target. Anchor to the `## The Question` heading.

### Step D4: Build the discussion body

Write a concise body (3-8 sentences) covering:
- What the topic is and why it needs team input
- What the current thinking is (if any)
- What the open question is
- What options exist (if discussed)

Keep it focused — this is async context for teammates, not a full spec.

### Step D5: Post the discussion

```bash
$MARGINS discuss create <slug> \
  --path <relative-file-path> \
  [--branch <branch>] \
  [--anchor-heading "<heading>"] \
  [--anchor-text "<text>"] \
  --body "<body>"
```

- `<slug>` is a positional argument (e.g. `gh/owner/repo`), not a flag
- `--path` must be relative to the repo root (e.g., `openspec/brief.md`)
- `--branch` defaults to current git branch — omit unless targeting a specific branch
- Omit `--anchor-heading` if the artifact isn't indexed yet (causes 422)

### Step D6: Confirm

The CLI outputs the full deep-link URL. Show it to the user:
```
Discussion created: <id>
View at: <serverUrl>/w/<slug>/-/<branch>/<path>#discussion-<id>
```
