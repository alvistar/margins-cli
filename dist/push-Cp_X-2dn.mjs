#!/usr/bin/env node
import { v as ValidationError } from "./config-DHEPrW--.mjs";
import { n as formatJson } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

//#region src/commands/workspace/push.ts
/** Recursively find all .md files in a directory, skipping symlinks. */
function globMarkdown(dir, base = "") {
	const results = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (entry.isSymbolicLink()) continue;
		const rel = base ? join(base, entry.name) : entry.name;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) results.push(...globMarkdown(full, rel));
		else if (entry.name.endsWith(".md")) results.push(rel.replace(/\\/g, "/"));
	}
	return results.sort();
}
async function handlePush(cfg, opts) {
	const client = createApiClient(cfg);
	const cwd = opts.dir ?? process.cwd();
	let workspaceId = opts.workspace;
	let createdSlug;
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
	const mdFiles = globMarkdown(cwd);
	if (mdFiles.length === 0) throw new ValidationError(`No .md files found in ${cwd}`);
	const files = mdFiles.map((relPath) => ({
		path: relPath,
		content: readFileSync(join(cwd, relPath), "utf-8")
	}));
	const result = await client.post(`/api/workspaces/${workspaceId}/ingest`, { files });
	if (cfg.json) console.log(formatJson({
		...result,
		...createdSlug ? {
			workspaceId,
			slug: createdSlug
		} : {}
	}));
	else {
		let line = `Pushed: ${result.added} added, ${result.changed} changed, ${result.skipped} skipped`;
		const addressed = result.addressed ?? 0;
		const orphaned = result.orphaned ?? 0;
		const moved = result.moved ?? 0;
		if (addressed > 0 || orphaned > 0 || moved > 0) line += ` (${addressed} addressed, ${orphaned} orphaned, ${moved} moved)`;
		console.log(line);
	}
}

//#endregion
export { globMarkdown, handlePush };