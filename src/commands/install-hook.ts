/**
 * `margins install-hook` — Install a git hook that syncs to Margins on push/commit.
 *
 * By default installs a pre-push hook. With `--on commit`, installs a post-commit
 * hook. Both run `margins workspace hook-sync` in the background so they never
 * block the git operation — but each first captures, SYNCHRONOUSLY, the piece of
 * git state that stops being available the moment the hook returns:
 *
 *   - pre-push reads the ref lines git writes to the hook's stdin. Git closes
 *     that pipe when the hook exits, and a background process re-deriving the
 *     state from `HEAD` would sync the checkout you are standing on rather than
 *     the ref you pushed.
 *   - post-commit resolves `HEAD` to an immutable object id. Committing again
 *     immediately moves the branch, so a background process handed the symbolic
 *     name would collect the LATER commit.
 *
 * Neither hook bakes in a content mode: the workspace decides, settled at the
 * preflight (KTD3). And neither can speak for the remote — a pre-push hook runs
 * before the push is accepted, so a rejected push leaves Margins ahead (KTD7).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { GIT_STDIO } from '../lib/git-branch.js'
import * as p from '@clack/prompts'

interface InstallHookOpts {
  on?: 'commit' | 'push'
  force?: boolean
}

const PRE_PUSH_HOOK = `#!/bin/sh
# Margins CAS sync — non-blocking pre-push hook
# Installed by: margins install-hook
# Reads workspace_id from .margins.json.
#
# Git writes one line per ref being pushed to this hook's stdin:
#   <local ref> <local object id> <remote ref> <remote object id>
# Consume it HERE, before backgrounding: git closes stdin as soon as the hook
# exits, so a reader that starts after the '&' reads from a dead pipe. The sync
# then targets the REMOTE ref name and the LOCAL object id, so pushing a branch
# you are not standing on — or to a differently-named remote branch — lands in
# the right place.
#
# NOTE: this runs before the remote accepts the push. A rejected push can leave
# Margins ahead of the remote.
refs=$(cat)
margins workspace hook-sync --event pre-push --refs "$refs" &
exit 0
`

const POST_COMMIT_HOOK = `#!/bin/sh
# Margins CAS sync — non-blocking post-commit hook
# Installed by: margins install-hook --on commit
# Reads workspace_id from .margins.json.
#
# Resolve the commit to an immutable object id HERE, before backgrounding. A
# literal 'HEAD' handed to a background process resolves whenever that process
# gets around to it — commit again straight away and it would sync the later
# commit instead of the one that just triggered this hook.
rev=$(git rev-parse HEAD) || exit 0
branch=$(git symbolic-ref --short -q HEAD)
margins workspace hook-sync --event post-commit --rev "$rev" --branch "$branch" &
exit 0
`

function gitText(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: GIT_STDIO }).trim()
}

/**
 * Ask git where the hooks live, and where the working tree starts.
 *
 * Walking up for a `.git` entry and appending `/hooks` assumes `.git` is a
 * DIRECTORY. In a linked worktree and in a submodule it is a FILE holding a
 * `gitdir:` pointer, and the append produces a path whose parent is a regular
 * file — so the install died with an unhandled ENOTDIR and no message. It also
 * got the wrong answer for `core.hooksPath` and for `GIT_DIR`.
 *
 * `rev-parse --git-path hooks` is correct in every one of those layouts (it
 * resolves worktrees to the shared hooks directory and submodules to
 * `.git/modules/<name>/hooks`). Its output is relative to the CWD, not to the
 * repository root, so it must be resolved against the CWD.
 */
function resolveGitLayout(cwd: string): { hooksDir: string; repoRoot: string } | null {
  try {
    const hooks = gitText(cwd, ['rev-parse', '--git-path', 'hooks'])
    const repoRoot = gitText(cwd, ['rev-parse', '--show-toplevel'])
    if (!hooks || !repoRoot) return null
    return { hooksDir: path.resolve(cwd, hooks), repoRoot }
  } catch {
    return null
  }
}

export async function handleInstallHook(opts: InstallHookOpts): Promise<void> {
  const layout = resolveGitLayout(process.cwd())
  if (!layout) {
    console.error('Error: Not a git repository (or not inside a working tree).')
    process.exit(1)
    return
  }
  const { hooksDir, repoRoot } = layout

  // Check .margins.json for syncMode before installing. It lives at the
  // repository root, which is not necessarily the directory this was run from.
  const configPath = path.join(repoRoot, '.margins.json')
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const syncMode = config.syncMode ?? (config.mode === 'local' ? 'client' : undefined)

      if (syncMode === 'server') {
        console.log('This workspace syncs via GitHub webhook — no hook needed.')
        console.log('Content is pulled by the server automatically on push.')
        return
      }
    } catch {
      // Malformed .margins.json — continue with hook installation
    }
  }

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
  if (!fs.existsSync(configPath)) {
    console.warn(`Warning: .margins.json not found in ${repoRoot}.`)
    console.warn(`Run \`margins sync\` first to register this folder and write .margins.json.`)
    console.warn(`Otherwise the hook will fail silently on every push.`)
  }
}
