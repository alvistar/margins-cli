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
# Reads workspace_id from .margins.json. Branch is detected from git automatically.
margins workspace push &
exit 0
`

const POST_COMMIT_HOOK = `#!/bin/sh
# Margins CAS sync — non-blocking post-commit hook
# Installed by: margins install-hook --on commit
# Reads workspace_id from .margins.json. Branch is detected from git automatically.
margins workspace push &
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

  // Warn if .margins.json is missing — the hook reads workspace_id from it.
  // Without it, `margins workspace push` errors out and (since the hook backgrounds
  // the call and exits 0) the failure is invisible.
  if (!fs.existsSync(path.join(dir, '.margins.json'))) {
    console.warn(`Warning: .margins.json not found in ${dir}.`)
    console.warn(`Run \`margins sync\` first to register this folder and write .margins.json.`)
    console.warn(`Otherwise the hook will fail silently on every push.`)
  }
}
