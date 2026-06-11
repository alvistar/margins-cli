#!/usr/bin/env node
import { v as ValidationError } from "./config-DqP75CeC.mjs";
import { n as formatJson } from "./output-EDs_B5hm.mjs";
import { t as createApiClient } from "./api-client-Dj9rmGKx.mjs";
import { i as skipOversized, n as collectSyncFiles, r as globMarkdown } from "./collect-sync-files-BZpXOHa2.mjs";
import { t as casSync } from "./cas-sync-DBUq0baj.mjs";
import { t as resolveSyncMode } from "./resolve-sync-mode-D4kcuBdZ.mjs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

//#region src/commands/workspace/push.ts
const GIT_STDIO = [
	"ignore",
	"pipe",
	"ignore"
];
function gitBranch(cwd) {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf-8",
			stdio: GIT_STDIO
		}).trim();
	} catch {
		return "main";
	}
}
async function handlePush(cfg, opts) {
	const client = createApiClient(cfg);
	const cwd = opts.dir ?? process.cwd();
	let workspaceId = opts.workspace;
	let createdSlug;
	if (!workspaceId) {
		const localCfgPath = join(cwd, ".margins.json");
		if (existsSync(localCfgPath)) try {
			const localCfg = JSON.parse(readFileSync(localCfgPath, "utf-8"));
			if (localCfg.workspace_id) workspaceId = localCfg.workspace_id;
		} catch {}
	}
	if (!workspaceId && opts.project) {
		const result = await client.post("/api/workspaces", {
			name: opts.project,
			source: "local",
			projectName: opts.project
		});
		workspaceId = result.workspace.id;
		createdSlug = result.workspace.slug;
		if (cfg.json) console.log(formatJson({
			created: true,
			workspaceId,
			slug: createdSlug
		}));
		else {
			console.log(`Created workspace: ${createdSlug}`);
			console.log(`Workspace ID: ${workspaceId}`);
		}
	}
	if (!workspaceId) throw new ValidationError("Specify --workspace <id> or --project <name> to create a new workspace");
	const localCfgForSync = join(cwd, ".margins.json");
	if (existsSync(localCfgForSync)) try {
		if (await resolveSyncMode(JSON.parse(readFileSync(localCfgForSync, "utf-8")), client, cwd) === "server") {
			console.error("This workspace uses server-managed sync. Use `margins workspace sync` instead.");
			process.exit(1);
		}
	} catch {}
	const collected = collectSyncFiles(cwd);
	const { mdCount, oversized } = collected;
	if (mdCount === 0) throw new ValidationError(`No .md files found in ${cwd}`);
	const syncFiles = skipOversized(collected);
	const branch = gitBranch(cwd);
	const result = await casSync(client, workspaceId, branch, syncFiles);
	if (cfg.json) console.log(formatJson({
		...result,
		...oversized.length > 0 ? {
			skippedOversized: oversized.length,
			oversizedPaths: oversized.map((f) => f.path)
		} : {},
		...createdSlug ? {
			workspaceId,
			slug: createdSlug
		} : {}
	}));
	else {
		let line = `Pushed: ${[
			`${result.added} added`,
			`${result.changed} changed`,
			`${result.deleted} deleted`
		].join(", ")}`;
		if (result.uploaded > 0 || result.skipped > 0) line += ` (${result.uploaded} uploaded, ${result.skipped} unchanged)`;
		if (oversized.length > 0) line += ` — ${oversized.length} oversized file(s) skipped`;
		console.log(line);
	}
}

//#endregion
export { handlePush };