import type { Command } from '@commander-js/extra-typings'

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const
type Shell = typeof SUPPORTED_SHELLS[number]

export function handleCompletions(program: Command, shell: string): void {
  if (!SUPPORTED_SHELLS.includes(shell as Shell)) {
    process.stderr.write(`Unsupported shell: ${shell}. Supported: bash, zsh, fish\n`)
    process.exit(1)
  }

  const script = generateScript(program, shell as Shell)
  process.stdout.write(script + '\n')
  process.stderr.write(`Hint: Add to your ~/.${shell}rc: eval "$(margins completions -s ${shell})"\n`)
}

function getCommandTree(cmd: Command): string[] {
  const names: string[] = []
  for (const sub of cmd.commands) {
    names.push(sub.name())
  }
  return names
}

function generateScript(program: Command, shell: Shell): string {
  if (shell === 'zsh') return generateZsh(program)
  if (shell === 'bash') return generateBash(program)
  return generateFish(program)
}

// ─── Zsh ──────────────────────────────────────────────────────────────────────

function generateZsh(program: Command): string {
  const topCmds = getCommandTree(program).join(' ')

  const subcompletions = program.commands.map((cmd) => {
    const subs = cmd.commands.map((s) => s.name()).join(' ')
    const isDynamic = cmd.name() === 'workspace' || cmd.name() === 'discuss'
    const slugCompletion = isDynamic
      ? `\n      '*') _margins_complete_slugs ;;`
      : ''
    return subs
      ? `    (${cmd.name()})
      case $words[3] in
        ${cmd.commands.map((s) => s.name()).join('|')}) ;;${slugCompletion}
        *) compadd ${subs} ;;
      esac`
      : `    (${cmd.name()}) ;;`
  }).join('\n')

  return `#compdef margins

_margins_complete_slugs() {
  local -a slugs
  slugs=("\${(@f)$(margins --completions workspace-slugs 2>/dev/null)}")
  compadd -a slugs
}

_margins() {
  local state

  _arguments \\
    '(-v --version)'{-v,--version}'[Print version]' \\
    '--json[Output as JSON]' \\
    '--verbose[Debug logging]' \\
    '--no-color[Disable colors]' \\
    '--server-url[Override server URL]:url:' \\
    '--api-key[Override API key]:key:' \\
    '1: :->command' \\
    '*: :->args'

  case $state in
    command)
      compadd ${topCmds}
      ;;
    args)
      case $words[2] in
${subcompletions}
      esac
      ;;
  esac
}

_margins "$@"`
}

// ─── Bash ─────────────────────────────────────────────────────────────────────

function generateBash(program: Command): string {
  const topCmds = getCommandTree(program).join(' ')

  const subcompletions = program.commands.map((cmd) => {
    const subs = cmd.commands.map((s) => s.name()).join(' ')
    return `        ${cmd.name()})
          COMPREPLY=($(compgen -W "${subs}" -- "$cur"))
          ;;`
  }).join('\n')

  return `_margins_completions() {
  local cur prev words
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "\${COMP_WORDS[1]}" in
${subcompletions}
    workspace)
      if [[ "$prev" == "sync" || "$prev" == "open" ]]; then
        local slugs
        slugs=$(margins --completions workspace-slugs 2>/dev/null)
        COMPREPLY=($(compgen -W "$slugs" -- "$cur"))
        return 0
      fi
      ;;
    *)
      COMPREPLY=($(compgen -W "${topCmds}" -- "$cur"))
      ;;
  esac
}

complete -F _margins_completions margins`
}

// ─── Fish ─────────────────────────────────────────────────────────────────────

function generateFish(program: Command): string {
  const lines: string[] = [
    '# margins fish completions',
    'complete -c margins -f',
    '',
    '# Top-level commands',
  ]

  for (const cmd of program.commands) {
    lines.push(`complete -c margins -n '__fish_use_subcommand' -a '${cmd.name()}' -d '${cmd.description()}'`)
  }

  lines.push('', '# Subcommands')
  for (const cmd of program.commands) {
    for (const sub of cmd.commands) {
      lines.push(`complete -c margins -n '__fish_seen_subcommand_from ${cmd.name()}' -a '${sub.name()}' -d '${sub.description()}'`)
    }
  }

  lines.push('', '# Dynamic: workspace slugs for sync/open')
  lines.push(`complete -c margins -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from sync open' -a '(margins --completions workspace-slugs 2>/dev/null)'`)

  return lines.join('\n')
}
