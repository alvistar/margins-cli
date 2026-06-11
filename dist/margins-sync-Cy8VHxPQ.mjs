#!/usr/bin/env node
import { v as ValidationError } from "./config-DqP75CeC.mjs";
import { a as SYNCABLE_IMAGE_EXTENSIONS, t as MAX_BLOB_SIZE } from "./collect-sync-files-BZpXOHa2.mjs";
import { n as parseGithubUrl } from "./detect-git-remote-h0Y5tWqZ.mjs";
import { execFile } from "node:child_process";

//#region src/lib/gh.ts
/**
* Thin wrapper around the `gh` CLI (operator's ambient GitHub auth).
*
* All GitHub access from `margins install` / `margins audit` goes through
* these functions — tests mock this module instead of child_process. Every
* invocation uses execFile (argv array), never a shell-interpolated string.
*/
const MAX_BUFFER = 64 * 1024 * 1024;
/** Typed error for failed gh invocations, carrying the HTTP status when parseable. */
var GhError = class extends Error {
	constructor(message, status, retryAfter) {
		super(message);
		this.status = status;
		this.retryAfter = retryAfter;
		this.name = "GhError";
	}
};
function runGh(args) {
	return new Promise((resolve, reject) => {
		execFile("gh", args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
			if (err) {
				const combined = `${stderr}\n${stdout}`;
				const statusMatch = /HTTP (\d{3})/.exec(combined);
				const status = statusMatch ? Number(statusMatch[1]) : void 0;
				const retryMatch = /retry[- ]after[:\s]+(\d+)/i.exec(combined);
				const retryAfter = retryMatch ? Number(retryMatch[1]) : void 0;
				reject(new GhError(stderr.trim() || err.message, status, retryAfter));
				return;
			}
			resolve(stdout);
		});
	});
}
async function ghApiJson(path, extraArgs = []) {
	const out = await runGh([
		"api",
		path,
		...extraArgs
	]);
	try {
		return JSON.parse(out);
	} catch {
		throw new GhError(`gh api ${path}: unparseable response`);
	}
}
async function getRepo(fullName) {
	const data = await ghApiJson(`repos/${fullName}`);
	return {
		id: data.id,
		ownerId: data.owner.id,
		fullName: data.full_name,
		defaultBranch: data.default_branch
	};
}
/** Shallow recursive file listing of a branch (blobs only). */
async function listTree(fullName, branch) {
	const data = await ghApiJson(`repos/${fullName}/git/trees/${branch}?recursive=1`);
	return {
		entries: data.tree.filter((e) => e.type === "blob").map((e) => ({
			path: e.path,
			size: e.size
		})),
		truncated: Boolean(data.truncated)
	};
}
/** List repo full names in an org (falls back to a user account on 404). */
async function listOrgRepos(org) {
	let out;
	try {
		out = await runGh([
			"api",
			`orgs/${org}/repos`,
			"--paginate",
			"--jq",
			".[].full_name"
		]);
	} catch (err) {
		if (err instanceof GhError && err.status === 404) out = await runGh([
			"api",
			`users/${org}/repos`,
			"--paginate",
			"--jq",
			".[].full_name"
		]);
		else throw err;
	}
	return out.split("\n").map((l) => l.trim()).filter(Boolean);
}
/** Blob SHA of a file at `path` on `ref`, or null if absent. */
async function getFileSha(fullName, path, ref) {
	try {
		return (await ghApiJson(`repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`)).sha;
	} catch (err) {
		if (err instanceof GhError && err.status === 404) return null;
		throw err;
	}
}
/** Decoded file content at `path` on `ref`, or null if absent. */
async function getFileContent(fullName, path, ref) {
	try {
		const data = await ghApiJson(`repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`);
		if (typeof data.content !== "string") return null;
		return Buffer.from(data.content, "base64").toString("utf-8");
	} catch (err) {
		if (err instanceof GhError && err.status === 404) return null;
		throw err;
	}
}
/** Tag name of the latest published release, or null if the repo has none. */
async function getLatestReleaseTag(fullName) {
	try {
		return (await ghApiJson(`repos/${fullName}/releases/latest`)).tag_name;
	} catch (err) {
		if (err instanceof GhError && err.status === 404) return null;
		throw err;
	}
}
/** Tag names, in the order the API returns them (most recent first). */
async function listTags(fullName) {
	return (await ghApiJson(`repos/${fullName}/tags`)).map((t) => t.name);
}
/** SHA a tag ref points at (commit, or tag object for annotated tags); null if absent. */
async function getTagSha(fullName, tag) {
	try {
		return (await ghApiJson(`repos/${fullName}/git/ref/${encodeURIComponent(`tags/${tag}`)}`)).object.sha;
	} catch (err) {
		if (err instanceof GhError && err.status === 404) return null;
		throw err;
	}
}
/** Commit SHA a branch points at. */
async function getBranchSha(fullName, branch) {
	return (await ghApiJson(`repos/${fullName}/git/ref/${encodeURIComponent(`heads/${branch}`)}`)).object.sha;
}
async function branchExists(fullName, branch) {
	try {
		await getBranchSha(fullName, branch);
		return true;
	} catch (err) {
		if (err instanceof GhError && err.status === 404) return false;
		throw err;
	}
}
async function createBranch(fullName, branch, sha) {
	await ghApiJson(`repos/${fullName}/git/refs`, [
		"-X",
		"POST",
		"-f",
		`ref=refs/heads/${branch}`,
		"-f",
		`sha=${sha}`
	]);
}
/** Create or update a file on a branch (contents API). */
async function putFile(fullName, opts) {
	const args = [
		"-X",
		"PUT",
		"-f",
		`message=${opts.message}`,
		"-f",
		`content=${opts.contentBase64}`,
		"-f",
		`branch=${opts.branch}`
	];
	if (opts.sha) args.push("-f", `sha=${opts.sha}`);
	await ghApiJson(`repos/${fullName}/contents/${opts.path}`, args);
}
async function createPullRequest(fullName, opts) {
	return { url: (await ghApiJson(`repos/${fullName}/pulls`, [
		"-X",
		"POST",
		"-f",
		`title=${opts.title}`,
		"-f",
		`head=${opts.head}`,
		"-f",
		`base=${opts.base}`,
		"-f",
		`body=${opts.body}`
	])).html_url };
}

//#endregion
//#region src/lib/audit-checks.ts
/**
* Server-cap pre-checks and workspace-lookup helpers shared by
* `margins install` and `margins audit`.
*
* Both commands run the same shallow-tree detection (file count + blob size
* against the server caps) so a repo flagged "over-cap" by audit is exactly
* a repo install would skip — one implementation, one verdict.
*/
/** Server MAX_MANIFEST_FILES default — repos over this are skipped/flagged. */
const MAX_MANIFEST_FILES = 1e3;
/**
* Extensions the sync workflow pushes: markdown plus every image type the
* collector uploads (derived from image-scanner's MIME table, the single
* source of truth — keeps this cap pre-check aligned with what push sends).
*/
const SYNC_EXTENSIONS = new RegExp(`\\.(md|${SYNCABLE_IMAGE_EXTENSIONS.join("|")})$`, "i");
/**
* Find the workspace bound to a GitHub repo by its "owner/repo" full name.
* URL normalization rule (one place only): parse the stored repoUrl with
* parseGithubUrl (handles https, .git suffix, trailing slash, and ssh forms)
* and compare owner/repo pairs case-insensitively.
*/
function findWorkspaceByRepoUrl(workspaces, fullName) {
	const want = fullName.toLowerCase();
	return workspaces.find((w) => {
		if (!w.repoUrl) return false;
		const parsed = parseGithubUrl(w.repoUrl.trim().replace(/\/+$/, ""));
		return parsed.type === "github" && `${parsed.owner}/${parsed.repo}`.toLowerCase() === want;
	});
}
/**
* Shallow tree listing of `branch`, counting syncable files and oversized
* blobs against the server caps. gh errors propagate to the caller.
*/
async function checkRepoCaps(fullName, branch) {
	const tree = await listTree(fullName, branch);
	const paths = new Set(tree.entries.map((e) => e.path));
	const syncable = tree.entries.filter((e) => SYNC_EXTENSIONS.test(e.path));
	if (syncable.length > 1e3 || tree.truncated) return {
		ok: false,
		syncableCount: syncable.length,
		paths,
		reason: `over server cap: ${tree.truncated ? "tree listing truncated" : `${syncable.length} syncable files`} (max ${MAX_MANIFEST_FILES})`
	};
	const oversized = syncable.filter((e) => (e.size ?? 0) > MAX_BLOB_SIZE);
	if (oversized.length > 0) return {
		ok: false,
		syncableCount: syncable.length,
		paths,
		reason: `over server cap: ${oversized.length} blob(s) over ${MAX_BLOB_SIZE} bytes (e.g. ${oversized[0].path})`
	};
	return {
		ok: true,
		syncableCount: syncable.length,
		paths
	};
}

//#endregion
//#region src/lib/repo-targets.ts
/**
* Repo-target resolution shared by `margins install` and `margins audit`:
* normalize a single target (owner/repo or GitHub URL), or list an org's
* repos and apply --include/--exclude glob filters.
*/
/** Normalize "owner/repo", https URL, or ssh remote to "owner/repo". */
function normalizeTarget(target) {
	const trimmed = target.trim();
	const parsed = parseGithubUrl(trimmed);
	if (parsed.type === "github") return `${parsed.owner}/${parsed.repo}`;
	const bare = trimmed.replace(/\.git$/, "");
	if (/^[^/\s]+\/[^/\s]+$/.test(bare)) return bare;
	throw new ValidationError(`Invalid repository target: ${target} (expected owner/repo or a GitHub URL)`);
}
function globToRegex(glob) {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}
/** Match against both the full name ("owner/repo") and the bare repo name. */
function matchesAny(fullName, globs) {
	const short = fullName.split("/")[1] ?? fullName;
	return globs.some((g) => {
		const re = globToRegex(g);
		return re.test(fullName) || re.test(short);
	});
}
function filterRepos(repos, include, exclude) {
	let result = repos;
	if (include && include.length > 0) result = result.filter((r) => matchesAny(r, include));
	if (exclude && exclude.length > 0) result = result.filter((r) => !matchesAny(r, exclude));
	return result;
}
/**
* Resolve the repo list for a run: a single normalized target, or an org
* listing with include/exclude filters applied. An empty result means no
* repos matched the filters — callers report and bail.
*/
async function resolveRepoTargets(target, opts) {
	if (!target && !opts.org) throw new ValidationError("Specify a repo (owner/repo or GitHub URL) or --org <org>");
	if (target && opts.org) throw new ValidationError("Specify a repo OR --org, not both");
	if (opts.org) return filterRepos(await listOrgRepos(opts.org), opts.include, opts.exclude);
	return [normalizeTarget(target)];
}

//#endregion
//#region src/templates/margins-sync.ts
/**
* Workflow template stamped by `margins install`.
*
* Kept as a TypeScript template-string constant (NOT a .yml asset) so it
* survives the tsdown bundle into the published package — a file asset would
* be missing at runtime on the npx path, and mocked-fs tests wouldn't catch it.
*
* Content mirrors margins-sync-action/templates/margins-sync.yml exactly.
*
* NOTE on trigger paths: the `on.push.paths` extension list below is a static
* convenience subset of the syncable types. The authoritative list of image
* extensions the sync actually uploads is SYNCABLE_IMAGE_EXTENSIONS in
* src/lib/image-scanner.ts (also what audit/install cap pre-checks count).
* Rarer types (avif/ico/bmp/tiff) still sync when a listed path retriggers.
*/
const WORKFLOW_PATH = ".github/workflows/margins-sync.yml";
const MARGINS_SYNC_TEMPLATE = `# Margins sync — stamped by \`margins install\` (schema-version 1).
# Pushes this repo's markdown + referenced images to its Margins workspace on
# every merge to the default branch. Auth is GitHub OIDC: no secrets stored.
name: Margins sync

on:
  push:
    branches: ["__DEFAULT_BRANCH__"]
    paths:
      - "**.md"
      - "**.png"
      - "**.jpg"
      - "**.jpeg"
      - "**.svg"
      - "**.gif"
      - "**.webp"
      # Config changes must retrigger sync too:
      - ".marginsignore"
      - ".github/workflows/margins-sync.yml"
  workflow_dispatch:

# Queue, don't cancel: cancellation has a grace window in which an older run's
# in-flight 409-retry could overwrite a newer run's tree. GitHub keeps at most
# one pending run and executes in order, so the last writer is always newest.
concurrency:
  group: margins-sync-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  id-token: write
  contents: read

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: alvistar/margins-sync-action@v1
        with:
          server-url: "__SERVER_URL__"
          workspace-id: "__WORKSPACE_ID__"
          schema-version: 1
`;
/** Conservative branch-name shape — anything else could break the stamped YAML. */
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;
/**
* Stamp the template placeholders. `serverUrl` is normalized to the origin
* (scheme + host, no trailing slash) — it doubles as the OIDC audience, which
* the server pins as an exact string. `defaultBranch` is validated against a
* conservative character set before stamping (workspaceId is server-issued).
*/
function stampTemplate(opts) {
	if (!BRANCH_NAME_RE.test(opts.defaultBranch)) throw new ValidationError(`Invalid default branch name for workflow stamping: "${opts.defaultBranch}"`);
	const origin = new URL(opts.serverUrl).origin;
	return MARGINS_SYNC_TEMPLATE.replaceAll("__DEFAULT_BRANCH__", opts.defaultBranch).replaceAll("__SERVER_URL__", origin).replaceAll("__WORKSPACE_ID__", opts.workspaceId);
}

//#endregion
export { putFile as _, findWorkspaceByRepoUrl as a, createBranch as c, getFileContent as d, getFileSha as f, listTags as g, getTagSha as h, checkRepoCaps as i, createPullRequest as l, getRepo as m, stampTemplate as n, GhError as o, getLatestReleaseTag as p, resolveRepoTargets as r, branchExists as s, WORKFLOW_PATH as t, getBranchSha as u };