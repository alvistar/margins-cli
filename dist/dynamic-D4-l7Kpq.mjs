#!/usr/bin/env node
import { t as createApiClient } from "./api-client-CMtOyXFg.mjs";
import { t as resolveWorkspaceBySlug } from "./resolve-workspace-CZ4J3CHG.mjs";

//#region src/completions/dynamic.ts
async function handleDynamicCompletions(cfg, type, opts = {}) {
	try {
		const client = createApiClient(cfg);
		if (type === "workspace-slugs") {
			const workspaces = await client.get("/api/workspaces");
			process.stdout.write(workspaces.map((w) => w.slug).join("\n") + "\n");
			return;
		}
		if (type === "discussion-ids") {
			if (!opts.workspace) return;
			const workspace = await resolveWorkspaceBySlug(client, opts.workspace);
			const discussions = await client.get(`/api/workspaces/${workspace.id}/artifacts`, { discussions: "true" });
			process.stdout.write(discussions.map((d) => d.id).join("\n") + "\n");
			return;
		}
	} catch {
		process.exit(0);
	}
}

//#endregion
export { handleDynamicCompletions };