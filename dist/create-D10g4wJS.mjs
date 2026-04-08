#!/usr/bin/env node
import { s as ConflictError, v as ValidationError } from "./config-DHEPrW--.mjs";
import { n as formatJson } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";

//#region src/commands/workspace/create.ts
async function handleCreate(cfg, repoUrl) {
	let parsedUrl;
	try {
		parsedUrl = new URL(repoUrl);
	} catch {
		throw new ValidationError(`Invalid repository URL: ${repoUrl}`);
	}
	const name = parsedUrl.pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") ?? repoUrl;
	const client = createApiClient(cfg);
	let workspace;
	try {
		const result = await client.post("/api/workspaces", {
			repoUrl,
			name
		});
		workspace = "workspace" in result ? result.workspace : result;
	} catch (err) {
		if (err instanceof ConflictError) throw new ConflictError(`Workspace already exists for ${repoUrl}`);
		throw err;
	}
	if (cfg.json) {
		console.log(formatJson(workspace));
		return;
	}
	console.log(`Workspace created: ${workspace.slug} (${workspace.name})`);
	console.log(`Open in browser: margins workspace open ${workspace.slug}`);
}

//#endregion
export { handleCreate };