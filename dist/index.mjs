#!/usr/bin/env node
import { o as AuthMissing, r as resolveConfig } from "./config-DHEPrW--.mjs";
import { t as formatError } from "./output-Tt66fI4Y.mjs";
import { Command, Option } from "@commander-js/extra-typings";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

//#region src/index.ts
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const program = new Command().name("margins").description("CLI for Margins — review layer for Markdown in Git").version(pkg.version, "-v, --version").option("--json", "Output as JSON (for scripting/agents)").option("--verbose", "Debug logging").option("--no-color", "Disable colors").option("--server-url <url>", "Override server URL").option("--api-key <key>", "Override API key").addOption(new Option("--completions <type>", "Internal: dynamic completion values").hideHelp());
const NO_AUTH_COMMANDS = new Set([
	"config",
	"completions",
	"help",
	"auth"
]);
program.hook("preAction", (_thisCommand, actionCommand) => {
	let cmd = actionCommand;
	while (cmd.parent && cmd.parent.parent) cmd = cmd.parent;
	const rootName = cmd.name();
	if (NO_AUTH_COMMANDS.has(rootName)) return;
	const globalOpts = program.opts();
	const cfg = resolveConfig({
		apiKey: globalOpts.apiKey,
		serverUrl: globalOpts.serverUrl,
		json: globalOpts.json,
		verbose: globalOpts.verbose,
		noColor: !(globalOpts.color ?? true)
	});
	if (!cfg.apiKey) {
		const err = new AuthMissing();
		process.stderr.write(formatError(err, cfg.json) + "\n");
		process.exit(1);
	}
	actionCommand.setOptionValue("_config", cfg);
});
function getConfig(cmd) {
	let c = cmd;
	while (c) {
		const cfg = c.getOptionValue?.("_config");
		if (cfg) return cfg;
		c = c.parent;
	}
	const globalOpts = program.opts();
	return resolveConfig({
		apiKey: globalOpts.apiKey,
		serverUrl: globalOpts.serverUrl,
		json: globalOpts.json,
		verbose: globalOpts.verbose,
		noColor: !(globalOpts.color ?? true)
	});
}
const configCmd = program.command("config").description("Manage CLI configuration");
configCmd.command("set-key <key>").description("Store an API key").action(async (key) => {
	const { handleSetKey } = await import("./set-key-XPqyGDO6.mjs");
	handleSetKey(key);
	console.log("API key saved.");
});
configCmd.command("set-url <url>").description("Set the server URL").action(async (url) => {
	const { handleSetUrl } = await import("./set-url-BuzfteIy.mjs");
	handleSetUrl(url);
	console.log("Server URL saved.");
});
configCmd.command("show").description("Display current configuration").action(async () => {
	const globalOpts = program.opts();
	const { handleShow } = await import("./show-4XKOVNU_.mjs");
	console.log(handleShow({ json: globalOpts.json ?? false }));
});
const authCmd = program.command("auth").description("Authentication commands");
authCmd.command("login").description("Log in via browser (Keycloak OAuth)").action(async (_opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleLogin } = await import("./login-2Z1q_4Yk.mjs");
	await handleLogin(cfg);
});
authCmd.command("whoami").description("Show current authenticated identity").action(async (_opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleWhoami } = await import("./whoami-A9NSIlpj.mjs");
	await handleWhoami(cfg);
});
authCmd.command("logout").description("Revoke the stored API key and clear local credentials").action(async (_opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleLogout } = await import("./logout-MG0wl17w.mjs");
	await handleLogout(cfg);
});
const wsCmd = program.command("workspace").description("Workspace management");
wsCmd.command("list").description("List all workspaces").action(async (_opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleList } = await import("./list-Dd-fB5gb.mjs");
	await handleList(cfg);
});
wsCmd.command("create <repo-url>").description("Create a workspace from a GitHub repo URL").action(async (repoUrl, _opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleCreate } = await import("./create-D10g4wJS.mjs");
	await handleCreate(cfg, repoUrl);
});
wsCmd.command("open [slug]").description("Open a workspace in the browser").action(async (slug, _opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleOpen } = await import("./open-Ci0HdBym.mjs");
	await handleOpen(cfg, slug);
});
wsCmd.command("sync [slug]").description("Trigger a git sync").option("--branch <branch>", "Branch to sync").action(async (slug, opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleSync } = await import("./sync-BBodDL6Y.mjs");
	await handleSync(cfg, slug, opts.branch);
});
wsCmd.command("push").description("Push local .md files to a workspace for review").option("--workspace <id>", "Workspace ID (omit to create new with --project)").option("--project <name>", "Create a new local workspace with this name").option("--dir <path>", "Directory to scan for .md files (default: cwd)").action(async (opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handlePush } = await import("./push-CCKdsiI1.mjs");
	await handlePush(cfg, opts);
});
const discussCmd = program.command("discuss").description("Discussion management");
discussCmd.command("list [slug]").description("List discussions").option("--path <path>", "Filter by artifact path").option("--status <status>", "Filter by status (open|resolved)", "open").action(async (slug, opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleDiscussList } = await import("./list-DqzdTi63.mjs");
	await handleDiscussList(cfg, slug, opts);
});
discussCmd.command("create [slug]").description("Create a discussion").requiredOption("--path <path>", "Artifact path").requiredOption("--body <body>", "Discussion body").option("--anchor-heading <heading>", "Anchor to heading").option("--anchor-text <text>", "Anchor to selected text").option("--branch <branch>", "Branch the artifact lives on (default: current git branch)").action(async (slug, opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleDiscussCreate } = await import("./create-COLzj287.mjs");
	await handleDiscussCreate(cfg, slug, opts);
});
discussCmd.command("reply <discussion-id>").description("Reply to a discussion").requiredOption("--body <body>", "Reply body").option("--workspace <slug>", "Workspace slug").action(async (discussionId, opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleDiscussReply } = await import("./reply-DY1izzTg.mjs");
	await handleDiscussReply(cfg, discussionId, opts);
});
discussCmd.command("resolve <discussion-id>").description("Resolve a discussion").option("--summary <summary>", "Resolution summary").option("--workspace <slug>", "Workspace slug").action(async (discussionId, opts, cmd) => {
	const cfg = getConfig(cmd);
	const { handleDiscussResolve } = await import("./resolve-UaD_rMAl.mjs");
	await handleDiscussResolve(cfg, discussionId, opts);
});
program.command("completions").description("Generate shell completion scripts").requiredOption("-s, --shell <shell>", "Shell type: bash, zsh, or fish").action(async (opts) => {
	const { handleCompletions } = await import("./completions-DCMnozKm.mjs");
	handleCompletions(program, opts.shell);
});
const completionsIdx = process.argv.indexOf("--completions");
if (completionsIdx !== -1 && process.argv[completionsIdx + 1]) {
	const type = process.argv[completionsIdx + 1];
	const cfg = resolveConfig({
		apiKey: process.env["MARGINS_API_KEY"] || void 0,
		serverUrl: process.env["MARGINS_SERVER_URL"] || void 0
	});
	const workspaceIdx = process.argv.indexOf("--workspace");
	const workspaceSlug = workspaceIdx !== -1 ? process.argv[workspaceIdx + 1] : void 0;
	import("./dynamic-BT_0Abuv.mjs").then(({ handleDynamicCompletions }) => handleDynamicCompletions(cfg, type, workspaceSlug ? { workspace: workspaceSlug } : {})).catch(() => process.exit(0));
} else program.parseAsync(process.argv).catch((err) => {
	const json = program.opts().json ?? false;
	process.stderr.write(formatError(err, json) + "\n");
	const code = err.exitCode ?? 1;
	process.exit(code);
});

//#endregion
export { program };