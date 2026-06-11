#!/usr/bin/env node
import { s as ConflictError } from "./config-DqP75CeC.mjs";
import { n as formatJson } from "./output-EDs_B5hm.mjs";
import { t as createApiClient } from "./api-client-Dj9rmGKx.mjs";
import { i as skipOversized, n as collectSyncFiles } from "./collect-sync-files-BZpXOHa2.mjs";
import { r as sanitizeProjectName, t as detectGitRemote } from "./detect-git-remote-h0Y5tWqZ.mjs";
import { r as R } from "./dist-DRq_WvKJ.mjs";
import { i as writeRegistry, n as normalize, r as readRegistry, t as addRepo } from "./registry-BjSteoiv.mjs";
import { t as casSync } from "./cas-sync-DBUq0baj.mjs";
import * as path$1 from "node:path";
import * as fs$1 from "node:fs";

//#region src/commands/sync.ts
/**
* `margins sync [dir]` — Set up a folder for continuous sync with Margins.
*
* This is a top-level command distinct from `margins workspace sync` (which
* triggers server-side git sync). This command:
* 1. Creates a workspace (GitHub overlay or local)
* 2. Pushes all .md files
* 3. Writes .margins.json + repos.json entry
* 4. The running tray app picks up the new entry within 5 seconds
*/
async function handleSync(cfg, opts) {
	const dir = path$1.resolve(opts.dir ?? ".");
	const isJson = cfg.json || opts.json;
	if (!fs$1.existsSync(dir)) {
		if (isJson) console.log(formatJson({ error: `Directory does not exist: ${dir}` }));
		else console.error(`Directory does not exist: ${dir}`);
		process.exit(1);
	}
	const client = createApiClient(cfg);
	const configPath = path$1.join(dir, ".margins.json");
	let marginsJson = null;
	if (fs$1.existsSync(configPath)) try {
		marginsJson = JSON.parse(fs$1.readFileSync(configPath, "utf-8"));
	} catch {}
	if (marginsJson?.workspace_id) {
		const registry = readRegistry();
		const normalizedDir = normalize(dir);
		if (registry.repos.find((r) => normalize(r.path) === normalizedDir)) {
			const url = `${cfg.serverUrl.replace(/\/$/, "")}/w/${marginsJson.workspace_slug}`;
			if (isJson) console.log(formatJson({
				status: "already_synced",
				workspaceId: marginsJson.workspace_id,
				slug: marginsJson.workspace_slug,
				url
			}));
			else {
				R.info(`Already synced: ${marginsJson.workspace_slug}`);
				R.info(url);
			}
			return;
		}
		if (!isJson) R.info(`Found .margins.json (workspace: ${marginsJson.workspace_slug}), resuming setup...`);
	}
	let workspaceId = marginsJson?.workspace_id ?? "";
	let slug = marginsJson?.workspace_slug ?? "";
	let syncMode = marginsJson?.syncMode ?? "client";
	if (!marginsJson?.syncMode && marginsJson?.mode === "overlay") syncMode = "client";
	let branch = marginsJson?.mode === "overlay" || syncMode === "server" ? "@local" : marginsJson?.default_branch ?? "main";
	if (!workspaceId) {
		const remote = detectGitRemote(dir);
		if (remote.type === "github") {
			const repoUrl = `https://github.com/${remote.owner}/${remote.repo}`;
			const folderName = path$1.basename(dir) || remote.repo;
			try {
				const result = await client.post("/api/workspaces", {
					name: folderName,
					source: "github",
					repoUrl
				});
				workspaceId = result.workspace.id;
				slug = result.workspace.slug;
				branch = "@local";
				syncMode = "client";
			} catch (err) {
				if (err instanceof ConflictError) {
					const found = await findExistingWorkspace(client, folderName);
					if (found) {
						workspaceId = found.id;
						slug = found.slug;
						branch = "@local";
						syncMode = "client";
					} else {
						if (!isJson) R.warn("GitHub workspace exists but not found in your list. Creating local workspace.");
						const local = await createLocalWorkspace(client, dir);
						workspaceId = local.id;
						slug = local.slug;
					}
				} else {
					if (!isJson) R.warn(`GitHub overlay failed, creating local workspace. (${err.message})`);
					const local = await createLocalWorkspace(client, dir);
					workspaceId = local.id;
					slug = local.slug;
				}
			}
		} else {
			const local = await createLocalWorkspace(client, dir);
			workspaceId = local.id;
			slug = local.slug;
		}
		const config = {
			workspace_slug: slug,
			workspace_id: workspaceId,
			default_branch: syncMode === "client" && branch !== "@local" ? "main" : void 0,
			syncMode
		};
		fs$1.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
	}
	const collected = collectSyncFiles(dir);
	const { mdCount, mdPaths: mdFiles, oversized } = collected;
	const syncFiles = skipOversized(collected);
	let pushResult = {
		added: 0,
		changed: 0,
		skipped: 0
	};
	if (mdCount > 0) {
		if (!isJson) R.info(`Pushing ${mdCount} .md file(s) via CAS...`);
		const casResult = await casSync(client, workspaceId, branch === "@local" ? "main" : branch, syncFiles);
		pushResult.added = casResult.added;
		pushResult.changed = casResult.changed;
		pushResult.skipped = casResult.skipped;
	}
	const lastMtimes = {};
	for (const relPath of mdFiles) try {
		lastMtimes[relPath] = fs$1.statSync(path$1.join(dir, relPath)).mtimeMs;
	} catch {}
	const registry = readRegistry();
	addRepo(registry, {
		path: dir,
		workspaceId,
		slug,
		branch,
		enabled: true,
		lastMtimes
	});
	writeRegistry(registry);
	const url = `${cfg.serverUrl.replace(/\/$/, "")}/w/${slug}`;
	if (isJson) console.log(formatJson({
		status: "synced",
		workspaceId,
		slug,
		branch,
		syncMode,
		files: mdFiles.length,
		...pushResult,
		...oversized.length > 0 ? {
			skippedOversized: oversized.length,
			oversizedPaths: oversized.map((f) => f.path)
		} : {},
		url
	}));
	else {
		if (mdFiles.length > 0) R.success(`Pushed: ${pushResult.added} added, ${pushResult.changed} changed, ${pushResult.skipped} skipped`);
		if (oversized.length > 0) R.warn(`${oversized.length} oversized file(s) skipped (over the 2MB server blob cap)`);
		R.success(`Synced: ${slug}`);
		R.info(url);
	}
}
async function createLocalWorkspace(client, dir) {
	const projectName = sanitizeProjectName(path$1.basename(dir) || "workspace");
	try {
		return (await client.post("/api/workspaces", {
			name: projectName,
			source: "local",
			projectName
		})).workspace;
	} catch (err) {
		if (err instanceof ConflictError) {
			const found = await findExistingWorkspace(client, projectName);
			if (found) return found;
			throw new Error(`Workspace '${projectName}' already exists but could not find it in your list.`);
		}
		throw err;
	}
}
async function findExistingWorkspace(client, name) {
	const workspaces = await client.get("/api/workspaces");
	const nameLower = name.toLowerCase();
	return workspaces.find((w) => w.slug.toLowerCase().endsWith(nameLower)) ?? null;
}

//#endregion
export { handleSync };