#!/usr/bin/env node
import * as path$1 from "node:path";
import * as fs$1 from "node:fs";

//#region src/lib/resolve-sync-mode.ts
/**
* Resolve the workspace's syncMode from .margins.json, handling legacy
* `mode: "overlay"` by querying the server.
*
* Priority:
* 1. syncMode field (new format) -> return directly
* 2. mode: "local" (legacy) -> always "client"
* 3. mode: "overlay" (legacy, ambiguous) -> query server, upgrade file in-place
* 4. Missing both -> default to "client" (safe fallback)
*/
async function resolveSyncMode(config, client, configDir) {
	if (config.syncMode === "server" || config.syncMode === "client") return config.syncMode;
	if (config.mode === "local") return "client";
	if (config.mode === "overlay" && config.workspace_id) try {
		const resolved = (await client.get(`/api/workspaces/${config.workspace_id}`)).syncMode === "server" ? "server" : "client";
		upgradeMarginsJson(config, resolved, configDir);
		return resolved;
	} catch {
		console.error("Cannot determine sync mode: server unreachable.\nRun again with network access, or manually add \"syncMode\": \"client\" (or \"server\") to .margins.json");
		process.exit(1);
	}
	return "client";
}
function upgradeMarginsJson(config, syncMode, configDir) {
	const dir = configDir ?? process.cwd();
	const configPath = path$1.join(dir, ".margins.json");
	if (!fs$1.existsSync(configPath)) return;
	try {
		const raw = JSON.parse(fs$1.readFileSync(configPath, "utf-8"));
		raw.syncMode = syncMode;
		fs$1.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
	} catch {}
}

//#endregion
export { resolveSyncMode as t };