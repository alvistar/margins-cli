/**
 * `margins install-hook` — Install a git hook that syncs to Margins on push/commit.
 *
 * By default installs a pre-push hook. With `--on commit`, installs a post-commit hook.
 * The hook runs `margins push` in the background so it never blocks git operations.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as p from '@clack/prompts'

interface InstallHookOpts {
  on?: 'commit' | 'push'
  force?: boolean
}

const PRE_PUSH_HOOK = `#!/bin/sh
# Margins CAS sync — non-blocking pre-push hook
# Installed by: margins install-hook
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
margins push --branch "$BRANCH" &
exit 0
`

const POST_COMMIT_HOOK = `#!/bin/sh
# Margins CAS sync — non-blocking post-commit hook
# Installed by: margins install-hook --on commit
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
margins push --branch "$BRANCH" &
exit 0
`

export async function handleInstallHook(opts: InstallHookOpts): Promise<void> {
  // Find .git directory (walk up from cwd)
  let dir = process.cwd()
  while (!fs.existsSync(path.join(dir, '.git'))) {
    const parent = path.dirname(dir)
    if (parent === dir) {
      console.error('Error: Not a git repository (no .git directory found).')
      process.exit(1)
    }
    dir = parent
  }

  const hooksDir = path.join(dir, '.git', 'hooks')
  const trigger = opts.on ?? 'push'
  const hookName = trigger === 'commit' ? 'post-commit' : 'pre-push'
  const hookPath = path.join(hooksDir, hookName)
  const hookContent = trigger === 'commit' ? POST_COMMIT_HOOK : PRE_PUSH_HOOK

  // Ensure hooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true })
  }

  // Check for existing hook
  if (fs.existsSync(hookPath)) {
    if (!opts.force) {
      const overwrite = await p.confirm({
        message: `${hookName} hook already exists. Overwrite?`,
      })
      if (p.isCancel(overwrite) || !overwrite) {
        p.cancel('Hook installation cancelled.')
        process.exit(0)
      }
    }
  }

  // Write the hook and make it executable
  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 })

  console.log(`Installed ${hookName} hook at ${hookPath}`)
}
