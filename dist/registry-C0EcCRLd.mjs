#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
	if (override) return path.join(override, "repos.json");
	const platform = os.platform();
	let base;
	if (platform === "darwin") base = path.join(os.homedir(), "Library", "Application Support");
	else if (platform === "win32") base = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
	else base = process.env["XDG_DATA_HOME"] || path.join(os.homedir(), ".local", "share");
	return path.join(base, "margins", "repos.json");
}
function readRegistry() {
	const regPath = registryPath();
	if (!fs.existsSync(regPath)) return { repos: [] };
	try {
		return JSON.parse(fs.readFileSync(regPath, "utf-8"));
	} catch {
		return { repos: [] };
	}
}
/** Atomic write: write to .tmp, then rename over target. */
function writeRegistry(registry) {
	const regPath = registryPath();
	const dir = path.dirname(regPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const tmpPath = regPath + ".tmp";
	fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
	fs.renameSync(tmpPath, regPath);
}
/** Normalize a path for dedup comparison. */
function normalize(p) {
	return path.resolve(p).replace(/\/+$/, "");
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