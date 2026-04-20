import { Command, Option } from '@commander-js/extra-typings'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveConfig, type ResolvedConfig } from './lib/config.js'
import { AuthMissing } from './lib/errors.js'
import { formatError } from './lib/output.js'

// ─── Package version ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as { version: string }

// ─── Root program ─────────────────────────────────────────────────────────────

export const program = new Command()
  .name('margins')
  .description('CLI for Margins — review layer for Markdown in Git')
  .version(pkg.version, '-v, --version')
  .option('--json', 'Output as JSON (for scripting/agents)')
  .option('--verbose', 'Debug logging')
  .option('--no-color', 'Disable colors')
  .option('--server-url <url>', 'Override server URL')
  .option('--api-key <key>', 'Override API key')
  // Hidden flag for dynamic shell completions
  .addOption(new Option('--completions <type>', 'Internal: dynamic completion values').hideHelp())

// ─── Auth hook ────────────────────────────────────────────────────────────────

const NO_AUTH_COMMANDS = new Set(['config', 'completions', 'help', 'auth'])
// Subcommands that are local-only and don't need server auth
const NO_AUTH_SUBCOMMANDS = new Set(['unsync'])

program.hook('preAction', (_thisCommand, actionCommand) => {
  // Commander passes (rootProgram, leafCommand) — use actionCommand (the leaf)
  // to identify which command group is running. Walk up to the top-level subcommand
  // (one level below root) so 'auth login' → 'auth', 'workspace sync' → 'workspace'.
  let cmd = actionCommand
  while (cmd.parent && cmd.parent.parent) cmd = cmd.parent
  const rootName = cmd.name()

  if (NO_AUTH_COMMANDS.has(rootName)) return
  if (NO_AUTH_SUBCOMMANDS.has(actionCommand.name())) return

  const globalOpts = program.opts()
  const cfg = resolveConfig({
    apiKey: globalOpts.apiKey,
    serverUrl: globalOpts.serverUrl,
    json: globalOpts.json,
    verbose: globalOpts.verbose,
    noColor: !(globalOpts.color as boolean | undefined ?? true),
  })

  if (!cfg.apiKey) {
    const err = new AuthMissing()
    process.stderr.write(formatError(err, cfg.json) + '\n')
    process.exit(1)
  }

  // Store resolved config on the action command so getConfig() can find it
  actionCommand.setOptionValue('_config', cfg)
})

// Helper to extract resolved config from a command (set by preAction hook)
function getConfig(cmd: Command): ResolvedConfig {
  // Walk up to find _config set by preAction
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c: any = cmd
  while (c) {
    const cfg = c.getOptionValue?.('_config')
    if (cfg) return cfg as ResolvedConfig
    c = c.parent
  }
  const globalOpts = program.opts()
  return resolveConfig({
    apiKey: globalOpts.apiKey,
    serverUrl: globalOpts.serverUrl,
    json: globalOpts.json,
    verbose: globalOpts.verbose,
    noColor: !(globalOpts.color as boolean | undefined ?? true),
  })
}

// ─── config subcommand ────────────────────────────────────────────────────────

const configCmd = program.command('config').description('Manage CLI configuration')

configCmd
  .command('set-key <key>')
  .description('Store an API key')
  .action(async (key) => {
    const { handleSetKey } = await import('./commands/config/set-key.js')
    handleSetKey(key)
    console.log('API key saved.')
  })

configCmd
  .command('set-url <url>')
  .description('Set the server URL')
  .action(async (url) => {
    const { handleSetUrl } = await import('./commands/config/set-url.js')
    handleSetUrl(url)
    console.log('Server URL saved.')
  })

configCmd
  .command('show')
  .description('Display current configuration')
  .action(async () => {
    const globalOpts = program.opts()
    const { handleShow } = await import('./commands/config/show.js')
    console.log(handleShow({ json: globalOpts.json ?? false }))
  })

// ─── auth subcommand ──────────────────────────────────────────────────────────

const authCmd = program.command('auth').description('Authentication commands')

authCmd
  .command('login')
  .description('Log in via browser (Keycloak OAuth)')
  .action(async (_opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleLogin } = await import('./commands/auth/login.js')
    await handleLogin(cfg)
  })

authCmd
  .command('whoami')
  .description('Show current authenticated identity')
  .action(async (_opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleWhoami } = await import('./commands/auth/whoami.js')
    await handleWhoami(cfg)
  })

authCmd
  .command('logout')
  .description('Revoke the stored API key and clear local credentials')
  .action(async (_opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleLogout } = await import('./commands/auth/logout.js')
    await handleLogout(cfg)
  })

// ─── workspace subcommand ─────────────────────────────────────────────────────

const wsCmd = program.command('workspace').description('Workspace management')

wsCmd
  .command('list')
  .description('List all workspaces')
  .action(async (_opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleList } = await import('./commands/workspace/list.js')
    await handleList(cfg)
  })

wsCmd
  .command('create <repo-url>')
  .description('Create a workspace from a GitHub repo URL')
  .action(async (repoUrl, _opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleCreate } = await import('./commands/workspace/create.js')
    await handleCreate(cfg, repoUrl)
  })

wsCmd
  .command('open [slug]')
  .description('Open a workspace in the browser')
  .action(async (slug, _opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleOpen } = await import('./commands/workspace/open.js')
    await handleOpen(cfg, slug)
  })

wsCmd
  .command('sync [slug]')
  .description('Trigger a git sync')
  .option('--branch <branch>', 'Branch to sync')
  .action(async (slug, opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleSync } = await import('./commands/workspace/sync.js')
    await handleSync(cfg, slug, opts.branch)
  })

wsCmd
  .command('push')
  .description('Push local .md files to a workspace for review')
  .option('--workspace <id>', 'Workspace ID (omit to create new with --project)')
  .option('--project <name>', 'Create a new local workspace with this name')
  .option('--dir <path>', 'Directory to scan for .md files (default: cwd)')
  .action(async (opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handlePush } = await import('./commands/workspace/push.js')
    await handlePush(cfg, opts)
  })

wsCmd
  .command('unsync')
  .description('Remove a folder from sync (local only, no auth required)')
  .option('--path <dir>', 'Folder path to unsync (default: cwd with .margins.json)')
  .option('--delete-config', 'Also delete .margins.json from the folder')
  .action(async (opts) => {
    const globalOpts = program.opts()
    const { handleUnsync } = await import('./commands/workspace/unsync.js')
    await handleUnsync({
      path: opts.path,
      deleteConfig: opts.deleteConfig,
      json: globalOpts.json,
    })
  })

// ─── discuss subcommand ───────────────────────────────────────────────────────

const discussCmd = program.command('discuss').description('Discussion management')

discussCmd
  .command('list [slug]')
  .description('List discussions')
  .option('--path <path>', 'Filter by artifact path')
  .option('--status <status>', 'Filter by status (open|resolved)', 'open')
  .action(async (slug, opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleDiscussList } = await import('./commands/discuss/list.js')
    await handleDiscussList(cfg, slug, opts)
  })

discussCmd
  .command('create [slug]')
  .description('Create a discussion')
  .requiredOption('--path <path>', 'Artifact path')
  .requiredOption('--body <body>', 'Discussion body')
  .option('--anchor-heading <heading>', 'Anchor to heading')
  .option('--anchor-text <text>', 'Anchor to selected text')
  .option('--branch <branch>', 'Branch the artifact lives on (default: current git branch)')
  .action(async (slug, opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleDiscussCreate } = await import('./commands/discuss/create.js')
    await handleDiscussCreate(cfg, slug, opts)
  })

discussCmd
  .command('reply <discussion-id>')
  .description('Reply to a discussion')
  .requiredOption('--body <body>', 'Reply body')
  .option('--workspace <slug>', 'Workspace slug')
  .action(async (discussionId, opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleDiscussReply } = await import('./commands/discuss/reply.js')
    await handleDiscussReply(cfg, discussionId, opts)
  })

discussCmd
  .command('resolve <discussion-id>')
  .description('Resolve a discussion')
  .option('--summary <summary>', 'Resolution summary')
  .option('--workspace <slug>', 'Workspace slug')
  .action(async (discussionId, opts, cmd) => {
    const cfg = getConfig(cmd)
    const { handleDiscussResolve } = await import('./commands/discuss/resolve.js')
    await handleDiscussResolve(cfg, discussionId, opts)
  })

// ─── completions subcommand ───────────────────────────────────────────────────

program
  .command('completions')
  .description('Generate shell completion scripts')
  .requiredOption('-s, --shell <shell>', 'Shell type: bash, zsh, or fish')
  .action(async (opts) => {
    const { handleCompletions } = await import('./commands/completions.js')
    handleCompletions(program, opts.shell)
  })

// ─── Dynamic completions dispatch ─────────────────────────────────────────────
// Intercept --completions <type> before normal command parsing.
// Shell completion scripts call `margins --completions workspace-slugs` and expect
// one value per line on stdout, with silent exit on any error.

const completionsIdx = process.argv.indexOf('--completions')
if (completionsIdx !== -1 && process.argv[completionsIdx + 1]) {
  const type = process.argv[completionsIdx + 1]!
  const cfg = resolveConfig({
    apiKey: process.env['MARGINS_API_KEY'] || undefined,
    serverUrl: process.env['MARGINS_SERVER_URL'] || undefined,
  })
  // Extract --workspace <slug> from argv for discussion-ids completions
  const workspaceIdx = process.argv.indexOf('--workspace')
  const workspaceSlug = workspaceIdx !== -1 ? process.argv[workspaceIdx + 1] : undefined
  import('./completions/dynamic.js').then(({ handleDynamicCompletions }) =>
    handleDynamicCompletions(cfg, type, workspaceSlug ? { workspace: workspaceSlug } : {}),
  ).catch(() => process.exit(0))
} else {
  // ─── Entry point ──────────────────────────────────────────────────────────────

  program.parseAsync(process.argv).catch((err: unknown) => {
    const json = program.opts().json ?? false
    process.stderr.write(formatError(err, json) + '\n')
    const code = (err as { exitCode?: number }).exitCode ?? 1
    process.exit(code)
  })
}
