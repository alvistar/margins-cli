#!/usr/bin/env node
import { r as R } from "./dist-DRq_WvKJ.mjs";
import { i as writeRegistry, n as normalize, r as readRegistry } from "./registry-BjSteoiv.mjs";
import * as path$1 from "node:path";
import * as fs$1 from "node:fs";

//#region src/commands/workspace/unsync.ts
/**
* Remove a repo from the local sync registry.
* This is a local-only operation — no server auth required.
*/
async function handleUnsync(opts) {
	let repoPath = opts.path;
	if (!repoPath) {
		const configPath = path$1.join(process.cwd(), ".margins.json");
		if (fs$1.existsSync(configPath)) try {
			JSON.parse(fs$1.readFileSync(configPath, "utf-8"));
			repoPath = process.cwd();
		} catch {}
	}
	if (!repoPath) {
		if (opts.json) {
			console.log(JSON.stringify({ error: "Not in a synced workspace. Use --path <dir>." }));
			process.exit(1);
		}
		console.error("Not in a synced workspace. Use --path <dir> to specify the folder.");
		process.exit(1);
	}
	repoPath = path$1.resolve(repoPath);
	const normalizedTarget = normalize(repoPath);
	const registry = readRegistry();
	const before = registry.repos.length;
	registry.repos = registry.repos.filter((r) => normalize(r.path) !== normalizedTarget);
	if (registry.repos.length === before) {
		if (opts.json) {
			console.log(JSON.stringify({ error: `Not synced: ${repoPath}` }));
			process.exit(1);
		}
		console.error(`Not synced: ${repoPath}`);
		process.exit(1);
	}
	if (opts.deleteConfig) {
		const configFile = path$1.join(repoPath, ".margins.json");
		if (fs$1.existsSync(configFile)) {
			fs$1.unlinkSync(configFile);
			if (!opts.json) R.info(`Deleted ${configFile}`);
		}
	}
	writeRegistry(registry);
	if (opts.json) console.log(JSON.stringify({
		status: "removed",
		path: repoPath
	}));
	else R.success(`Removed ${repoPath} from sync.`);
}

//#endregion
export { handleUnsync };