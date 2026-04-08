---
name: margins
description: |
  Post a discussion to the Margins review platform for the current repo.
  Creates the workspace automatically if it doesn't exist (1 workspace per repo).
  Infers which file and anchor point to use from the topic and conversation context.
  If no relevant file exists, creates openspec/decisions/<slug>.md with context first.

  Use when the user wants to:
  - Flag a decision for team discussion ("post this to Margins", "create a margins discussion", "/margins <topic>")
  - Get async human input on an architecture or design choice
  - Record a decision point that needs team sign-off
  - Start a threaded discussion anchored to a specific file/section
---

# /margins — Post a Discussion to Margins

## Preamble: resolve the `margins` binary

```bash
# Resolve margins CLI binary
if command -v margins &>/dev/null; then
  MARGINS="margins"
elif [ -f "$(git rev-parse --show-toplevel 2>/dev/null)/margins-cli/bin/margins.js" ]; then
  MARGINS="node $(git rev-parse --show-toplevel)/margins-cli/bin/margins.js"
else
  MARGINS="npx --yes github:alvistar/margins-cli"
fi
```

Use `$MARGINS` for every command below.

## Step 1: Get repo URL and derive workspace slug

```bash
REPO_URL=$(git remote get-url origin 2>/dev/null)
```

If empty, ask the user for the repo URL.

Normalize SSH to HTTPS:
- `git@github.com:owner/repo.git` -> `https://github.com/owner/repo`
- `git@gitlab.com:owner/repo.git` -> `https://gitlab.com/owner/repo`
- Strip trailing `.git` if present

Derive the workspace slug (mirrors the server's `parseSlug()` logic):
- GitHub: `https://github.com/owner/repo` -> `gh/owner/repo`
- GitLab: `https://gitlab.com/owner/repo` -> `gl/owner/repo`
- Other: use `<host-without-tld>/<owner>/<repo>`

## Step 2: Ensure workspace exists

```bash
$MARGINS workspace create "$REPO_URL" 2>&1
```

- If it succeeds, workspace created, slug is confirmed
- If it exits with a conflict error (workspace already exists), proceed with derived slug
- If it fails for any other reason, surface the error and stop

If the command fails with an auth error, tell the user:
> "Run `/margins-setup` to configure authentication, then retry `/margins`."

## Step 3: Infer target file and anchor

From `$ARGUMENTS` (the topic) and conversation context, choose the best file to anchor the discussion to.

**Priority order:**
1. A file being actively discussed in conversation (spec, brief, source file)
2. The most relevant openspec file: `openspec/changes/<active-change>/brief.md`, a `spec.md`, or `decisions.md`
3. A source file clearly related to the topic (e.g., if the topic is about auth, look at auth-related files)
4. If nothing fits, create a new decision document (Step 3b)

**Choosing the anchor:**
- Scan the target file for the most relevant heading. Use `--anchor-heading "<heading text>"`.
- If no heading fits but a specific text excerpt is relevant, use `--anchor-text "<quoted snippet>"`.
- If the file has no obvious anchor point, omit both flags (discussion attaches to the document root).

### Step 3b: Create a decision document (when no file fits)

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

## Step 4: Build the discussion body

Write a concise body (3-8 sentences) covering:
- What the topic is and why it needs team input
- What the current thinking is (if any)
- What the open question is
- What options exist (if discussed)

Keep it focused — this is async context for teammates, not a full spec.

## Step 5: Post the discussion

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

## Step 6: Confirm

The CLI outputs the full deep-link URL. Show it to the user:
```
Discussion created: <id>
View at: <serverUrl>/w/<slug>/-/<branch>/<path>#discussion-<id>
```
