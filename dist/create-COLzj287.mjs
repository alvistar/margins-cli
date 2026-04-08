#!/usr/bin/env node
import { n as readLocalConfig, v as ValidationError } from "./config-DHEPrW--.mjs";
import { n as formatJson } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";
import { t as resolveWorkspaceBySlug } from "./resolve-workspace-CCRy89Zw.mjs";
import { execSync } from "node:child_process";

//#region src/commands/discuss/create.ts
function detectGitBranch() {
	try {
		return execSync("git branch --show-current", {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).trim() || void 0;
	} catch {
		return;
	}
}
async function handleDiscussCreate(cfg, slug, opts) {
	const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug;
	if (!resolvedSlug) throw new ValidationError("No workspace specified. Pass a slug or create .margins.json");
	const client = createApiClient(cfg);
	const workspace = await resolveWorkspaceBySlug(client, resolvedSlug);
	const payload = { body: opts.body };
	if (opts.anchorHeading) {
		payload["anchorType"] = "heading";
		payload["anchorHeadingText"] = opts.anchorHeading;
	} else if (opts.anchorText) {
		payload["anchorType"] = "text";
		payload["anchorSelectedText"] = opts.anchorText;
	}
	const discussion = await client.post(`/api/workspaces/${workspace.id}/artifacts?path=${encodeURIComponent(opts.path)}`, payload);
	if (cfg.json) {
		console.log(formatJson(discussion));
		return;
	}
	const branch = opts.branch ?? detectGitBranch() ?? workspace.defaultBranch ?? "main";
	console.log(`Discussion created: ${discussion.id}`);
	console.log(`View at: ${cfg.serverUrl}/w/${resolvedSlug}/-/${branch}/${opts.path}#discussion-${discussion.id}`);
}

//#endregion
export { handleDiscussCreate };