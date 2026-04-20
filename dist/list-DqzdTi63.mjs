#!/usr/bin/env node
import { n as readLocalConfig, v as ValidationError } from "./config-DHEPrW--.mjs";
import { n as formatJson, r as formatTable } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";
import { t as resolveWorkspaceBySlug } from "./resolve-workspace-CCRy89Zw.mjs";

//#region src/commands/discuss/list.ts
async function handleDiscussList(cfg, slug, opts) {
	const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug;
	if (!resolvedSlug) throw new ValidationError("No workspace specified. Pass a slug or create .margins.json");
	const client = createApiClient(cfg);
	const workspace = await resolveWorkspaceBySlug(client, resolvedSlug);
	const query = { discussions: "true" };
	if (opts.path) query["path"] = opts.path;
	if (opts.status) query["status"] = opts.status;
	const discussions = await client.get(`/api/workspaces/${workspace.id}/artifacts`, query);
	if (cfg.json) {
		console.log(formatJson(discussions));
		return;
	}
	if (!discussions.length) {
		console.log("No discussions found.");
		return;
	}
	console.log(formatTable([
		"ID",
		"Path",
		"Anchor",
		"Author",
		"Status",
		"Body preview"
	], discussions.map((d) => [
		d.id.slice(0, 8),
		d.path ?? "(unknown)",
		d.anchorHeadingText ?? d.anchorSelectedText ?? "(doc)",
		d.authorName ?? "unknown",
		d.status,
		d.body.slice(0, 60) + (d.body.length > 60 ? "…" : "")
	])));
}

//#endregion
export { handleDiscussList };