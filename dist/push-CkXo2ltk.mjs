#!/usr/bin/env node
import { v as ValidationError } from "./config-DHEPrW--.mjs";
import { n as formatJson } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-b0eZ67v3.mjs";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

//#region src/lib/cas-sync.ts
function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}
/**
* Run an async function for each item with bounded concurrency.
* Returns results in the same order as items.
*/
async function poolMap(items, concurrency, fn) {
	const results = new Array(items.length);
	let nextIndex = 0;
	async function worker() {
		while (nextIndex < items.length) {
			const idx = nextIndex++;
			results[idx] = await fn(items[idx]);
		}
	}
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}
const UPLOAD_CONCURRENCY = 5;
/**
* Content-addressable sync protocol.
*
* 1. Fetch the server manifest for the branch
* 2. Compute SHA-256 of each local file, diff against manifest
* 3. Upload new/changed blobs (up to 5 concurrent)
* 4. Commit the new manifest
*/
async function casSync(client, workspaceId, branch, commitSha, parentSha, files) {
	const basePath = `/api/workspaces/${workspaceId}/sync`;
	const serverFiles = (await client.get(`${basePath}/manifest`, { branch })).files ?? {};
	const localFiles = {};
	const localByHash = /* @__PURE__ */ new Map();
	for (const file of files) {
		const hash = sha256(file.content);
		localFiles[file.path] = hash;
		localByHash.set(hash, file);
	}
	let added = 0;
	let changed = 0;
	const deleted = Object.keys(serverFiles).filter((p) => !(p in localFiles)).length;
	const hashesOnServer = new Set(Object.values(serverFiles));
	const hashesToUpload = /* @__PURE__ */ new Set();
	for (const [filePath, hash] of Object.entries(localFiles)) {
		const serverHash = serverFiles[filePath];
		if (serverHash === void 0) {
			added++;
			if (!hashesOnServer.has(hash)) hashesToUpload.add(hash);
		} else if (serverHash !== hash) {
			changed++;
			if (!hashesOnServer.has(hash)) hashesToUpload.add(hash);
		}
	}
	const toUpload = [...hashesToUpload];
	await poolMap(toUpload, UPLOAD_CONCURRENCY, async (hash) => {
		const file = localByHash.get(hash);
		await client.putRaw(`${basePath}/objects/${hash}`, file.content, file.contentType);
	});
	const uploaded = toUpload.length;
	await client.post(`${basePath}/manifest`, {
		branch,
		commitSha,
		parentSha,
		files: localFiles
	});
	return {
		added,
		changed,
		deleted,
		uploaded,
		skipped: files.length - added - changed
	};
}

//#endregion
//#region src/lib/image-scanner.ts
const MIME_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".tiff": "image/tiff",
	".tif": "image/tiff"
};
function mimeFromPath(filePath) {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return null;
	return MIME_TYPES[filePath.slice(dot).toLowerCase()] ?? null;
}
/**
* Extract image paths referenced in a markdown file.
*
* Matches:
*   - ![alt](path)              — standard markdown images
*   - ![alt](path "title")      — markdown images with title
*   - <img src="path" ...>      — HTML img tags (single or double quotes)
*
* Skips:
*   - Remote URLs (http://, https://, data:)
*   - Paths that resolve outside repoRoot
*   - Symlinks
*
* Returns deduplicated list of image paths relative to repoRoot.
*/
function scanImagesInMarkdown(mdContent, mdFilePath, repoRoot) {
	const mdDir = dirname(resolve(repoRoot, mdFilePath));
	const resolvedRoot = resolve(repoRoot);
	const seen = /* @__PURE__ */ new Set();
	const results = [];
	const mdImageRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	const htmlImgRe = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
	const rawPaths = [];
	let match;
	while ((match = mdImageRe.exec(mdContent)) !== null) rawPaths.push(match[1]);
	while ((match = htmlImgRe.exec(mdContent)) !== null) rawPaths.push(match[1]);
	for (const raw of rawPaths) {
		if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) continue;
		let decoded;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			decoded = raw;
		}
		const abs = resolve(mdDir, decoded);
		const relFromRoot = relative(resolvedRoot, abs);
		if (relFromRoot.startsWith("..") || relFromRoot.startsWith(sep + sep)) continue;
		try {
			if (lstatSync(abs).isSymbolicLink()) continue;
		} catch {}
		const normalized = relFromRoot.replace(/\\/g, "/");
		if (!seen.has(normalized)) {
			seen.add(normalized);
			results.push(normalized);
		}
	}
	return results;
}

//#endregion
//#region src/lib/marginsignore.ts
/**
* .marginsignore support — gitignore-compatible file filtering.
*
* Loads default ignore patterns (node_modules, .git, dotfiles) plus any
* patterns from a `.marginsignore` file in the repo root. Returns a filter
* function that returns true for files that should be INCLUDED (not ignored).
*/
/** Default patterns always applied (gitignore syntax). */
const DEFAULT_PATTERNS = [
	"node_modules/",
	".git/",
	".*"
];
/**
* Convert a single gitignore pattern to a RegExp.
*
* Supports:
*   - `*` matches anything except `/`
*   - `**` matches everything including `/`
*   - `?` matches any single char except `/`
*   - Trailing `/` matches directories (we treat as prefix match)
*   - Leading `!` negates the pattern
*   - Leading `/` anchors to root (otherwise matches anywhere)
*   - `#` lines and blank lines are skipped (handled by caller)
*/
function compilePattern(raw) {
	let pattern = raw.trim();
	if (!pattern || pattern.startsWith("#")) return null;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("\\")) pattern = pattern.slice(1);
	let anchored = false;
	if (pattern.startsWith("/")) {
		anchored = true;
		pattern = pattern.slice(1);
	}
	const dirOnly = pattern.endsWith("/");
	if (dirOnly) pattern = pattern.slice(0, -1);
	if (pattern.includes("/")) anchored = true;
	let regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0DOUBLESTAR\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0DOUBLESTAR\0/g, ".*");
	if (dirOnly) regexStr = anchored ? `^${regexStr}(?:/|$)` : `(?:^|/)${regexStr}(?:/|$)`;
	else if (anchored) regexStr = `^${regexStr}(?:$|/)`;
	else regexStr = `(?:^|/)${regexStr}(?:$|/)`;
	return {
		regex: new RegExp(regexStr),
		negated
	};
}
/**
* Load ignore rules from `.marginsignore` (if present) combined with
* built-in defaults. Returns a predicate that returns `true` for files
* that should be INCLUDED (i.e. not ignored).
*/
function loadIgnoreFilter(repoRoot) {
	const patterns = [];
	for (const raw of DEFAULT_PATTERNS) {
		const compiled = compilePattern(raw);
		if (compiled) patterns.push(compiled);
	}
	const ignorePath = join(repoRoot, ".marginsignore");
	if (existsSync(ignorePath)) {
		const lines = readFileSync(ignorePath, "utf-8").split("\n");
		for (const line of lines) {
			const compiled = compilePattern(line);
			if (compiled) patterns.push(compiled);
		}
	}
	return (filePath) => {
		const normalized = filePath.replace(/\\/g, "/");
		let ignored = false;
		for (const { regex, negated } of patterns) if (regex.test(normalized) || regex.test("/" + normalized)) ignored = !negated;
		return !ignored;
	};
}

//#endregion
//#region src/commands/workspace/push.ts
/** Recursively find all .md files in a directory, skipping symlinks. */
function globMarkdown(dir, base = "") {
	const results = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (entry.isSymbolicLink()) continue;
		const rel = base ? join(base, entry.name) : entry.name;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) results.push(...globMarkdown(full, rel));
		else if (entry.name.endsWith(".md")) results.push(rel.replace(/\\/g, "/"));
	}
	return results.sort();
}
const GIT_STDIO = [
	"ignore",
	"pipe",
	"ignore"
];
function gitBranch(cwd) {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf-8",
			stdio: GIT_STDIO
		}).trim();
	} catch {
		return "main";
	}
}
function gitCommitSha(cwd) {
	try {
		return execSync("git rev-parse HEAD", {
			cwd,
			encoding: "utf-8",
			stdio: GIT_STDIO
		}).trim();
	} catch {
		return "unknown";
	}
}
function gitParentSha(cwd) {
	try {
		return execSync("git rev-parse HEAD~1", {
			cwd,
			encoding: "utf-8",
			stdio: GIT_STDIO
		}).trim();
	} catch {
		return null;
	}
}
async function handlePush(cfg, opts) {
	const client = createApiClient(cfg);
	const cwd = opts.dir ?? process.cwd();
	let workspaceId = opts.workspace;
	let createdSlug;
	if (!workspaceId) {
		const localCfgPath = join(cwd, ".margins.json");
		if (existsSync(localCfgPath)) try {
			const localCfg = JSON.parse(readFileSync(localCfgPath, "utf-8"));
			if (localCfg.workspace_id) workspaceId = localCfg.workspace_id;
		} catch {}
	}
	if (!workspaceId && opts.project) {
		const result = await client.post("/api/workspaces", {
			name: opts.project,
			source: "local",
			projectName: opts.project
		});
		workspaceId = result.workspace.id;
		createdSlug = result.workspace.slug;
		if (cfg.json) console.log(formatJson({
			created: true,
			workspaceId,
			slug: createdSlug
		}));
		else {
			console.log(`Created workspace: ${createdSlug}`);
			console.log(`Workspace ID: ${workspaceId}`);
		}
	}
	if (!workspaceId) throw new ValidationError("Specify --workspace <id> or --project <name> to create a new workspace");
	const allMdFiles = globMarkdown(cwd);
	const ignoreFilter = loadIgnoreFilter(cwd);
	const mdFiles = allMdFiles.filter(ignoreFilter);
	if (mdFiles.length === 0) throw new ValidationError(`No .md files found in ${cwd}`);
	const syncFiles = [];
	const seenPaths = /* @__PURE__ */ new Set();
	for (const relPath of mdFiles) {
		const content = readFileSync(join(cwd, relPath));
		syncFiles.push({
			path: relPath,
			content,
			contentType: "text/markdown"
		});
		seenPaths.add(relPath);
		const imagePaths = scanImagesInMarkdown(content.toString("utf-8"), relPath, cwd);
		for (const imgPath of imagePaths) {
			if (seenPaths.has(imgPath)) continue;
			const imgFull = join(cwd, imgPath);
			if (!existsSync(imgFull)) continue;
			const mime = mimeFromPath(imgPath);
			if (!mime) continue;
			try {
				const imgContent = readFileSync(imgFull);
				syncFiles.push({
					path: imgPath,
					content: imgContent,
					contentType: mime
				});
				seenPaths.add(imgPath);
			} catch {}
		}
	}
	const branch = gitBranch(cwd);
	const commitSha = gitCommitSha(cwd);
	const parentSha = gitParentSha(cwd);
	const result = await casSync(client, workspaceId, branch, commitSha, parentSha, syncFiles);
	if (cfg.json) console.log(formatJson({
		...result,
		...createdSlug ? {
			workspaceId,
			slug: createdSlug
		} : {}
	}));
	else {
		let line = `Pushed: ${[
			`${result.added} added`,
			`${result.changed} changed`,
			`${result.deleted} deleted`
		].join(", ")}`;
		if (result.uploaded > 0 || result.skipped > 0) line += ` (${result.uploaded} uploaded, ${result.skipped} unchanged)`;
		console.log(line);
	}
}

//#endregion
export { globMarkdown, handlePush };