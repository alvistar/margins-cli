#!/usr/bin/env node
//#region src/commands/completions.ts
const SUPPORTED_SHELLS = [
	"bash",
	"zsh",
	"fish"
];
function handleCompletions(program, shell) {
	if (!SUPPORTED_SHELLS.includes(shell)) {
		process.stderr.write(`Unsupported shell: ${shell}. Supported: bash, zsh, fish\n`);
		process.exit(1);
	}
	const script = generateScript(program, shell);
	process.stdout.write(script + "\n");
	process.stderr.write(`Hint: Add to your ~/.${shell}rc: eval "$(margins completions -s ${shell})"\n`);
}
function getCommandTree(cmd) {
	const names = [];
	for (const sub of cmd.commands) names.push(sub.name());
	return names;
}
function generateScript(program, shell) {
	if (shell === "zsh") return generateZsh(program);
	if (shell === "bash") return generateBash(program);
	return generateFish(program);
}
function generateZsh(program) {
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
      compadd ${getCommandTree(program).join(" ")}
      ;;
    args)
      case $words[2] in
${program.commands.map((cmd) => {
		const subs = cmd.commands.map((s) => s.name()).join(" ");
		const slugCompletion = cmd.name() === "workspace" || cmd.name() === "discuss" ? `\n      '*') _margins_complete_slugs ;;` : "";
		return subs ? `    (${cmd.name()})
      case $words[3] in
        ${cmd.commands.map((s) => s.name()).join("|")}) ;;${slugCompletion}
        *) compadd ${subs} ;;
      esac` : `    (${cmd.name()}) ;;`;
	}).join("\n")}
      esac
      ;;
  esac
}

_margins "$@"`;
}
function generateBash(program) {
	const topCmds = getCommandTree(program).join(" ");
	return `_margins_completions() {
  local cur prev words
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "\${COMP_WORDS[1]}" in
${program.commands.map((cmd) => {
		const subs = cmd.commands.map((s) => s.name()).join(" ");
		return `        ${cmd.name()})
          COMPREPLY=($(compgen -W "${subs}" -- "$cur"))
          ;;`;
	}).join("\n")}
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

complete -F _margins_completions margins`;
}
function generateFish(program) {
	const lines = [
		"# margins fish completions",
		"complete -c margins -f",
		"",
		"# Top-level commands"
	];
	for (const cmd of program.commands) lines.push(`complete -c margins -n '__fish_use_subcommand' -a '${cmd.name()}' -d '${cmd.description()}'`);
	lines.push("", "# Subcommands");
	for (const cmd of program.commands) for (const sub of cmd.commands) lines.push(`complete -c margins -n '__fish_seen_subcommand_from ${cmd.name()}' -a '${sub.name()}' -d '${sub.description()}'`);
	lines.push("", "# Dynamic: workspace slugs for sync/open");
	lines.push(`complete -c margins -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from sync open' -a '(margins --completions workspace-slugs 2>/dev/null)'`);
	return lines.join("\n");
}

//#endregion
export { handleCompletions };