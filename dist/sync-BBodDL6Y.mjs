#!/usr/bin/env node
import { n as readLocalConfig, s as ConflictError, v as ValidationError } from "./config-DHEPrW--.mjs";
import { n as formatJson } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";
import { t as resolveWorkspaceBySlug } from "./resolve-workspace-CCRy89Zw.mjs";
import * as p from "@clack/prompts";

//#region src/commands/workspace/sync.ts
async function handleSync(cfg, slug, branch) {
	const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug;
	if (!resolvedSlug) throw new ValidationError("No workspace specified. Pass a slug or create .margins.json");
	const client = createApiClient(cfg);
	const workspace = await resolveWorkspaceBySlug(client, resolvedSlug);
	if (!cfg.json) {
		const spinner = p.spinner();
		spinner.start(`Syncing ${resolvedSlug}...`);
		let result;
		try {
			result = await client.post(`/api/workspaces/${workspace.id}/sync`, branch ? { branch } : {});
		} catch (err) {
			if (err instanceof ConflictError) {
				spinner.stop(`Sync already in progress for ${resolvedSlug}.`);
				return;
			}
			throw err;
		}
		if (result.status === "already_running" || result.status === "syncing") {
			spinner.stop(`Sync already in progress for ${resolvedSlug}.`);
			return;
		}
		spinner.stop(`Sync complete. ${result.artifactsUpdated ?? 0} artifacts updated.`);
	} else try {
		const result = await client.post(`/api/workspaces/${workspace.id}/sync`, branch ? { branch } : {});
		console.log(formatJson(result));
	} catch (err) {
		if (err instanceof ConflictError) {
			console.log(formatJson({
				status: "already_running",
				message: `Sync already in progress for ${resolvedSlug}.`
			}));
			return;
		}
		throw err;
	}
}

//#endregion
export { handleSync };