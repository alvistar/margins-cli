#!/usr/bin/env node
import { n as readLocalConfig, s as ConflictError, v as ValidationError } from "./config-DqP75CeC.mjs";
import { n as formatJson } from "./output-EDs_B5hm.mjs";
import { t as createApiClient } from "./api-client-Dj9rmGKx.mjs";
import { s as be } from "./dist-DRq_WvKJ.mjs";
import { t as resolveWorkspaceBySlug } from "./resolve-workspace-DISiB_kk.mjs";
import { t as resolveSyncMode } from "./resolve-sync-mode-D4kcuBdZ.mjs";

//#region src/commands/workspace/sync.ts
async function handleSync(cfg, slug, branch) {
	const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug;
	if (!resolvedSlug) throw new ValidationError("No workspace specified. Pass a slug or create .margins.json");
	const client = createApiClient(cfg);
	const localCfg = readLocalConfig();
	if (localCfg) {
		if (await resolveSyncMode(localCfg, client) === "client") {
			console.error("This workspace uses client-managed sync. Use `margins workspace push` instead.");
			process.exit(1);
		}
	}
	const workspace = await resolveWorkspaceBySlug(client, resolvedSlug);
	if (!cfg.json) {
		const spinner = be();
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