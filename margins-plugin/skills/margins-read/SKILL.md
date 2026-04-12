---
name: margins-read
description: |
  Fetch and act on open discussions from the Margins review platform for the current repo.
  Groups discussions by file, formats them for reading, then asks the user what to do next.

  Use when the user wants to:
  - Check what's open for discussion in Margins ("show margins discussions", "/margins-read")
  - Review team feedback on a spec or decision doc
  - Reply to or resolve a Margins discussion
  - Pull open discussions into the current working context
---

# /margins-read — Fetch and Act on Open Margins Discussions

## Preamble: resolve binary, project config, and workspace slug

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

# 3. Walk up looking for .margins.json (workspace_slug + workspace_id from /margins push)
SLUG=""
WORKSPACE_ID=""
DIR="$PWD"
while [ "$DIR" != "/" ]; do
  if [ -f "$DIR/.margins.json" ]; then
    SLUG=$(jq -r '.workspace_slug // empty' "$DIR/.margins.json")
    WORKSPACE_ID=$(jq -r '.workspace_id // empty' "$DIR/.margins.json")
    break
  fi
  DIR=$(dirname "$DIR")
done
```

Use `$MARGINS` in place of `margins` for every command in the steps below.

If `npx` is also unavailable, tell the user:
> "Node.js is required. Install it from https://nodejs.org, then retry."

## Step 1: Confirm workspace slug

If `$SLUG` is empty after the preamble walk-up, fall back to git remote derivation:
get `git remote get-url origin`, normalize to HTTPS, derive slug
(`https://github.com/owner/repo` → `gh/owner/repo`).

If `$SLUG` is still empty after both lookups, say:
> "No Margins workspace found for this directory. Run `/margins push` to create one (uploads local .md files for review), or `/margins <topic>` if you have a GitHub remote configured."

And stop.

## Step 2: Fetch open discussions

```bash
$MARGINS discuss list <slug> --status open --json
```

If the command fails with an auth error, tell the user:
> "Run `$MARGINS auth login` first, then retry `/margins-read`."

## Step 3: Format and display

If no open discussions:
> "No open discussions in `<slug>`."

Otherwise, group by `path`. For each group:

```
── openspec/brief.md ──────────────────────────────────────
  [abc123] "Should we use JWT or API keys for CLI auth?"
  Author: alice  |  Anchor: ## Authentication Design
  Body: We need to decide how the CLI authenticates. JWT gives us
        token refresh but adds complexity. API keys are simpler...

  [def456] "Scoping: include workspace sync in MVP?"
  Author: bob  |  Anchor: ## Scope
  Body: The sync command is complex. Could defer to v1.1...

── openspec/decisions/token-storage.md ────────────────────
  [ghi789] "Which token storage location is most portable?"
  Author: alice  |  Anchor: ## The Question
  Body: macOS Keychain is most secure but Linux support is patchy...
```

Show at most the first 200 chars of each body, truncating with `…`.

Print the total at the end:
```
N open discussion(s) across M file(s).
```

## Step 4: Ask what to do next

Present an AskUserQuestion:

> "What would you like to do?"

Options:
- **Reply** — Add a reply to a specific discussion
- **Resolve** — Mark a discussion as resolved
- **Add to TODOS.md** — Convert a discussion into a TODOS.md entry
- **Continue working** — Dismiss and return to current task

### If Reply

Ask: "Which discussion ID? (paste the short ID shown above)"
Ask: "What's your reply?"

Run:
```bash
$MARGINS discuss reply <id> --body "<reply>" --workspace <slug>
```

Confirm: `Reply posted to <id>.`

### If Resolve

Ask: "Which discussion ID?"

Run:
```bash
$MARGINS discuss resolve <id> --workspace <slug>
```

Confirm: `Discussion <id> resolved.`

### If Add to TODOS.md

Ask: "Which discussion ID?"

Append to `TODOS.md`:

```markdown
### <discussion body first sentence, or topic> (from Margins — <id>)
<Full discussion body>
**File:** `<path>` @ `<anchor>`
**Author:** <author> | **Discussion:** <id>
**Added:** <date> (from /margins-read)
```

Confirm: `Added to TODOS.md.`

### If Continue working

Exit cleanly with no output.
