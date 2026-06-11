#!/usr/bin/env node
import * as path$1 from "node:path";
import * as fs$1 from "node:fs";
import * as os$1 from "node:os";

//#region src/lib/registry.ts
/**
* Shared registry module for repos.json — the contract between margins-cli and margins-desktop.
* Both the CLI `margins sync` and the desktop tray app read/write this file.
*
* Atomic writes: write to .tmp then rename (POSIX rename is atomic).
* Path: MARGINS_DATA_DIR env → platform data_local_dir/margins/repos.json
*/
/**
* Resolve the registry path, matching the desktop app's Rust logic:
*   MARGINS_DATA_DIR env var → dirs::data_local_dir()/margins/repos.json
*
* Platform equivalents:
*   macOS:   ~/Library/Application Support/margins/repos.json
*   Linux:   ~/.local/share/margins/repos.json
*   Windows: %LOCALAPPDATA%/margins/repos.json
*/
function registryPath() {
	const override = process.env["MARGINS_DATA_DIR"];
	if (override) return path$1.join(override, "repos.json");
	const platform = os$1.platform();
	let base;
	if (platform === "darwin") base = path$1.join(os$1.homedir(), "Library", "Application Support");
	else if (platform === "win32") base = process.env["LOCALAPPDATA"] || path$1.join(os$1.homedir(), "AppData", "Local");
	else base = process.env["XDG_DATA_HOME"] || path$1.join(os$1.homedir(), ".local", "share");
	return path$1.join(base, "margins", "repos.json");
}
function readRegistry() {
	const regPath = registryPath();
	if (!fs$1.existsSync(regPath)) return { repos: [] };
	try {
		return JSON.parse(fs$1.readFileSync(regPath, "utf-8"));
	} catch {
		return { repos: [] };
	}
}
/** Atomic write: write to .tmp, then rename over target. */
function writeRegistry(registry) {
	const regPath = registryPath();
	const dir = path$1.dirname(regPath);
	if (!fs$1.existsSync(dir)) fs$1.mkdirSync(dir, { recursive: true });
	const tmpPath = regPath + ".tmp";
	fs$1.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
	fs$1.renameSync(tmpPath, regPath);
}
/** Normalize a path for dedup comparison. */
function normalize(p) {
	return path$1.resolve(p).replace(/\/+$/, "");
}
/**
* Add a repo to the registry. Deduplicates by resolved path.
* Returns true if the repo was added (not a duplicate).
*/
function addRepo(registry, entry) {
	const normalizedNew = normalize(entry.path);
	if (registry.repos.some((r) => normalize(r.path) === normalizedNew)) return false;
	registry.repos.push(entry);
	return true;
}

//#endregion
export { writeRegistry as i, normalize as n, readRegistry as r, addRepo as t };