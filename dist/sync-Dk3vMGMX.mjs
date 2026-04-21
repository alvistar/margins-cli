#!/usr/bin/env node
import { s as ConflictError } from "./config-DHEPrW--.mjs";
import { n as formatJson } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";
import { i as writeRegistry, n as normalize, r as readRegistry, t as addRepo } from "./registry-C0EcCRLd.mjs";
import { globMarkdown } from "./push-Cp_X-2dn.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { execSync } from "node:child_process";

//#region src/lib/detect-git-remote.ts
/**
* Git remote detection — ported from Rust margins-desktop/src-tauri/src/workspace/detect.rs
*/
/** Detect the git remote for a directory by running `git remote get-url origin`. */
function detectGitRemote(dir) {
	try {
		const url = execSync("git remote get-url origin", {
			cwd: dir,
			encoding: "utf-8",
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
		if (!url) return { type: "none" };
		return parseGithubUrl(url);
	} catch {
		return { type: "none" };
	}
}
/**
* Parse a URL into a GitRemote.
*
* Handles:
*   - https://github.com/owner/repo.git
*   - https://github.com/owner/repo
*   - git@github.com:owner/repo.git
*   - ssh://git@github.com/owner/repo.git
*/
function parseGithubUrl(url) {
	if (url.startsWith("git@github.com:")) {
		const [owner, repo] = url.slice(15).replace(/\.git$/, "").split("/");
		if (owner && repo) return {
			type: "github",
			owner,
			repo: repo.split("/")[0]
		};
	}
	if (url.includes("github.com")) {
		for (const prefix of [
			"https://github.com/",
			"http://github.com/",
			"ssh://git@github.com/"
		]) if (url.startsWith(prefix)) {
			const [owner, repo] = url.slice(prefix.length).replace(/\.git$/, "").split("/");
			if (owner && repo) return {
				type: "github",
				owner,
				repo: repo.split("/")[0]
			};
		}
	}
	return url ? {
		type: "other",
		url
	} : { type: "none" };
}
/**
* Sanitize a folder name for use as a Margins project name.
* Rules: lowercase, only [a-z0-9._-], max 64 chars, no leading/trailing dashes.
*/
function sanitizeProjectName(name) {
	return name.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "workspace";
}

//#endregion
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
	const dir = path.resolve(opts.dir ?? ".");
	const isJson = cfg.json || opts.json;
	if (!fs.existsSync(dir)) {
		if (isJson) console.log(formatJson({ error: `Directory does not exist: ${dir}` }));
		else console.error(`Directory does not exist: ${dir}`);
		process.exit(1);
	}
	const client = createApiClient(cfg);
	const configPath = path.join(dir, ".margins.json");
	let marginsJson = null;
	if (fs.existsSync(configPath)) try {
		marginsJson = JSON.parse(fs.readFileSync(configPath, "utf-8"));
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
				p.log.info(`Already synced: ${marginsJson.workspace_slug}`);
				p.log.info(url);
			}
			return;
		}
		if (!isJson) p.log.info(`Found .margins.json (workspace: ${marginsJson.workspace_slug}), resuming setup...`);
	}
	let workspaceId = marginsJson?.workspace_id ?? "";
	let slug = marginsJson?.workspace_slug ?? "";
	let mode = marginsJson?.mode ?? "local";
	let branch = mode === "overlay" ? "@local" : marginsJson?.default_branch ?? "main";
	if (!workspaceId) {
		const remote = detectGitRemote(dir);
		if (remote.type === "github") {
			const repoUrl = `https://github.com/${remote.owner}/${remote.repo}`;
			const folderName = path.basename(dir) || remote.repo;
			try {
				const result = await client.post("/api/workspaces", {
					name: folderName,
					source: "github",
					repoUrl
				});
				workspaceId = result.workspace.id;
				slug = result.workspace.slug;
				branch = "@local";
				mode = "overlay";
			} catch (err) {
				if (err instanceof ConflictError) {
					const found = await findExistingWorkspace(client, folderName);
					if (found) {
						workspaceId = found.id;
						slug = found.slug;
						branch = "@local";
						mode = "overlay";
					} else {
						if (!isJson) p.log.warn("GitHub workspace exists but not found in your list. Creating local workspace.");
						const local = await createLocalWorkspace(client, dir);
						workspaceId = local.id;
						slug = local.slug;
					}
				} else {
					if (!isJson) p.log.warn(`GitHub overlay failed, creating local workspace. (${err.message})`);
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
			default_branch: mode === "local" ? "main" : void 0,
			mode
		};
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
	}
	const mdFiles = globMarkdown(dir);
	let pushResult = {
		added: 0,
		changed: 0,
		skipped: 0
	};
	if (mdFiles.length > 0) {
		if (!isJson) p.log.info(`Pushing ${mdFiles.length} .md file(s)...`);
		const BATCH_SIZE = 50;
		for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
			const files = mdFiles.slice(i, i + BATCH_SIZE).map((relPath) => ({
				path: relPath,
				content: fs.readFileSync(path.join(dir, relPath), "utf-8")
			}));
			const result = await client.post(`/api/workspaces/${workspaceId}/ingest`, { files });
			pushResult.added += result.added;
			pushResult.changed += result.changed;
			pushResult.skipped += result.skipped;
		}
	}
	const lastMtimes = {};
	for (const relPath of mdFiles) try {
		lastMtimes[relPath] = fs.statSync(path.join(dir, relPath)).mtimeMs;
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
		mode,
		files: mdFiles.length,
		...pushResult,
		url
	}));
	else {
		if (mdFiles.length > 0) p.log.success(`Pushed: ${pushResult.added} added, ${pushResult.changed} changed, ${pushResult.skipped} skipped`);
		p.log.success(`Synced: ${slug}`);
		p.log.info(url);
	}
}
async function createLocalWorkspace(client, dir) {
	const projectName = sanitizeProjectName(path.basename(dir) || "workspace");
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