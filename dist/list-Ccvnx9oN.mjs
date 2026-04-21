#!/usr/bin/env node
import { n as formatJson, r as formatTable } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";

//#region src/commands/workspace/list.ts
function formatDate(iso) {
	if (!iso) return "never";
	return new Date(iso).toLocaleDateString(void 0, {
		month: "short",
		day: "numeric",
		year: "numeric"
	});
}
async function handleList(cfg) {
	const workspaces = await createApiClient(cfg).get("/api/workspaces");
	if (cfg.json) {
		console.log(formatJson(workspaces));
		return;
	}
	if (!workspaces.length) {
		console.log("No workspaces found. Create one: margins workspace create <repo-url>");
		return;
	}
	console.log(formatTable([
		"Slug",
		"Name",
		"Status",
		"Last synced"
	], workspaces.map((w) => [
		w.slug,
		w.name,
		w.syncStatus ?? "idle",
		formatDate(w.lastSyncedAt)
	])));
}

//#endregion
export { handleList };