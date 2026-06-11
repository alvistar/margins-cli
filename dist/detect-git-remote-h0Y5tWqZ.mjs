#!/usr/bin/env node
import { execSync } from "node:child_process";

//#region src/lib/detect-git-remote.ts
/**
* Git remote detection — ported from Rust margins-desktop/src-tauri/src/workspace/detect.rs
*/
/** Detect the git remote for a directory by running `git remote get-url origin`. */
function detectGitRemote(dir) {
	try {
		const url = execSync("git remote get-url origin", {
			cwd: dir,
			encoding: "utf-8",
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
		if (!url) return { type: "none" };
		return parseGithubUrl(url);
	} catch {
		return { type: "none" };
	}
}
/**
* Parse a URL into a GitRemote.
*
* Handles:
*   - https://github.com/owner/repo.git
*   - https://github.com/owner/repo
*   - git@github.com:owner/repo.git
*   - ssh://git@github.com/owner/repo.git
*/
function parseGithubUrl(url) {
	if (url.startsWith("git@github.com:")) {
		const [owner, repo] = url.slice(15).replace(/\.git$/, "").split("/");
		if (owner && repo) return {
			type: "github",
			owner,
			repo: repo.split("/")[0]
		};
	}
	if (url.includes("github.com")) {
		for (const prefix of [
			"https://github.com/",
			"http://github.com/",
			"ssh://git@github.com/"
		]) if (url.startsWith(prefix)) {
			const [owner, repo] = url.slice(prefix.length).replace(/\.git$/, "").split("/");
			if (owner && repo) return {
				type: "github",
				owner,
				repo: repo.split("/")[0]
			};
		}
	}
	return url ? {
		type: "other",
		url
	} : { type: "none" };
}
/**
* Sanitize a folder name for use as a Margins project name.
* Rules: lowercase, only [a-z0-9._-], max 64 chars, no leading/trailing dashes.
*/
function sanitizeProjectName(name) {
	return name.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "workspace";
}

//#endregion
export { parseGithubUrl as n, sanitizeProjectName as r, detectGitRemote as t };