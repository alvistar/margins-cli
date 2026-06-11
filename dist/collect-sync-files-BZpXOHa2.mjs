#!/usr/bin/env node
import { dirname, join, relative, resolve, sep } from "node:path";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";

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
/**
* Image extensions (without the leading dot) the sync pipeline uploads —
* the single source of truth, derived from {@link MIME_TYPES}. Anything with
* a recognized MIME type here is collected and pushed.
*/
const SYNCABLE_IMAGE_EXTENSIONS = Object.keys(MIME_TYPES).map((ext) => ext.slice(1));
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
//#region src/lib/collect-sync-files.ts
/**
* Shared file-collection pipeline for local CAS sync (`workspace push`, `sync`).
* (install/audit cap pre-checks read the GitHub tree instead — see
* src/lib/audit-checks.ts; only MAX_BLOB_SIZE is shared with them.)
*
* Globs markdown files (skipping dotdirs, node_modules, symlinks), applies the
* `.marginsignore` filter, and collects referenced images (deduplicated; missing
* refs and unsupported mime types skipped). Also reports blobs over the server's
* MAX_BLOB_SIZE so callers can warn before uploads that would fail server-side.
*/
/** Server-side per-blob size cap (margins MAX_BLOB_SIZE). */
const MAX_BLOB_SIZE = 2 * 1024 * 1024;
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
/**
* Collect all syncable files under `dir`: filtered markdown plus referenced
* images. `maxBlobSize` is overridable for tests; defaults to the server cap.
*/
function collectSyncFiles(dir, opts = {}) {
	const maxBlobSize = opts.maxBlobSize ?? 2097152;
	const allMdFiles = globMarkdown(dir);
	const ignoreFilter = loadIgnoreFilter(dir);
	const mdFiles = allMdFiles.filter(ignoreFilter);
	const files = [];
	const seenPaths = /* @__PURE__ */ new Set();
	for (const relPath of mdFiles) {
		const content = readFileSync(join(dir, relPath));
		files.push({
			path: relPath,
			content,
			contentType: "text/markdown"
		});
		seenPaths.add(relPath);
		const imagePaths = scanImagesInMarkdown(content.toString("utf-8"), relPath, dir);
		for (const imgPath of imagePaths) {
			if (seenPaths.has(imgPath)) continue;
			const imgFull = join(dir, imgPath);
			if (!existsSync(imgFull)) continue;
			const mime = mimeFromPath(imgPath);
			if (!mime) continue;
			try {
				files.push({
					path: imgPath,
					content: readFileSync(imgFull),
					contentType: mime
				});
				seenPaths.add(imgPath);
			} catch {}
		}
	}
	const oversized = files.filter((f) => f.content.length > maxBlobSize).map((f) => ({
		path: f.path,
		bytes: f.content.length
	}));
	return {
		files,
		mdCount: mdFiles.length,
		mdPaths: mdFiles,
		totalCount: files.length,
		oversized
	};
}
/**
* Drop oversized blobs from a collected file set, reporting the skipped paths
* on stderr. One >2 MB file must not 413-abort the whole push: the server
* would reject the blob anyway, so it is excluded from the upload set AND
* (since casSync derives the manifest from the files it receives) from the
* manifest. Shared by `workspace push` and `sync`.
*/
function skipOversized(collected) {
	const { files, oversized } = collected;
	if (oversized.length === 0) return files;
	process.stderr.write(`Warning: skipping ${oversized.length} file(s) over the ${MAX_BLOB_SIZE / (1024 * 1024)}MB server blob cap:\n` + oversized.map((f) => `  ${f.path} (${f.bytes} bytes)\n`).join(""));
	const skip = new Set(oversized.map((f) => f.path));
	return files.filter((f) => !skip.has(f.path));
}

//#endregion
export { SYNCABLE_IMAGE_EXTENSIONS as a, skipOversized as i, collectSyncFiles as n, globMarkdown as r, MAX_BLOB_SIZE as t };