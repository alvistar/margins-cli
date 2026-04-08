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

Use `$MARGINS` in place of `margins` for every command in the steps below.

## Step 1: Get workspace slug

Same as `/margins` Step 1 — get `git remote get-url origin`, normalize to HTTPS, derive slug.

If workspace doesn't exist yet, say:
> "No Margins workspace found for this repo. Run `/margins <topic>` to create one."

And stop.

## Step 2: Fetch open discussions

```bash
$MARGINS discuss list <slug> --status open --json
```

If the command fails with an auth error, tell the user:
> "Run `/margins-setup` to configure authentication, then retry `/margins-read`."

## Step 3: Format and display

If no open discussions:
> "No open discussions in `<slug>`."

Otherwise, group by `path`. For each group:

```
-- openspec/brief.md ------
  [abc123] "Should we use JWT or API keys for CLI auth?"
  Author: alice  |  Anchor: ## Authentication Design
  Body: We need to decide how the CLI authenticates. JWT gives us
        token refresh but adds complexity. API keys are simpler...

  [def456] "Scoping: include workspace sync in MVP?"
  Author: bob  |  Anchor: ## Scope
  Body: The sync command is complex. Could defer to v1.1...

-- openspec/decisions/token-storage.md ----
  [ghi789] "Which token storage location is most portable?"
  Author: alice  |  Anchor: ## The Question
  Body: macOS Keychain is most secure but Linux support is patchy...
```

Show at most the first 200 chars of each body, truncating with ...

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
