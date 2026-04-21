#!/usr/bin/env node
import { i as writeRegistry, n as normalize, r as readRegistry } from "./registry-C0EcCRLd.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";

//#region src/commands/workspace/unsync.ts
/**
* Remove a repo from the local sync registry.
* This is a local-only operation — no server auth required.
*/
async function handleUnsync(opts) {
	let repoPath = opts.path;
	if (!repoPath) {
		const configPath = path.join(process.cwd(), ".margins.json");
		if (fs.existsSync(configPath)) try {
			JSON.parse(fs.readFileSync(configPath, "utf-8"));
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
	repoPath = path.resolve(repoPath);
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
		const configFile = path.join(repoPath, ".margins.json");
		if (fs.existsSync(configFile)) {
			fs.unlinkSync(configFile);
			if (!opts.json) p.log.info(`Deleted ${configFile}`);
		}
	}
	writeRegistry(registry);
	if (opts.json) console.log(JSON.stringify({
		status: "removed",
		path: repoPath
	}));
	else p.log.success(`Removed ${repoPath} from sync.`);
}

//#endregion
export { handleUnsync };