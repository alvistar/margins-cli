#!/usr/bin/env node
import { n as formatJson, r as formatTable } from "./output-EDs_B5hm.mjs";
import { t as createApiClient } from "./api-client-Dj9rmGKx.mjs";
import { a as findWorkspaceByRepoUrl, d as getFileContent, g as listTags, h as getTagSha, i as checkRepoCaps, m as getRepo, o as GhError, p as getLatestReleaseTag, r as resolveRepoTargets, t as WORKFLOW_PATH } from "./margins-sync-Cy8VHxPQ.mjs";
import { t as poolMap } from "./pool-CnaDQno0.mjs";

//#region src/commands/audit.ts
/** The public action repo whose releases define "latest". */
const ACTION_REPO = "alvistar/margins-sync-action";
/** Repos audited concurrently per run (reads only — no write-safety concern). */
const AUDIT_CONCURRENCY = 5;
/** Extract the `uses: alvistar/margins-sync-action@<ref>` ref from a workflow. */
function parseActionPin(workflow) {
	return new RegExp(`uses:\\s*${"alvistar/margins-sync-action".replace("/", "\\/")}@([^\\s'"#]+)`).exec(workflow)?.[1] ?? null;
}
const SHA_RE = /^[0-9a-f]{40}$/i;
const TAG_RE = /^v\d+(\.\d+){0,2}$/;
/**
* Latest released action version: GitHub release first, tags-list fallback.
* Any gh failure → null ("unknown latest"; pins are then reported as-is).
*/
async function resolveLatestAction() {
	let tag = null;
	try {
		tag = await getLatestReleaseTag(ACTION_REPO);
		if (!tag) tag = (await listTags("alvistar/margins-sync-action")).find((t) => TAG_RE.test(t)) ?? null;
	} catch {
		return null;
	}
	if (!tag) return null;
	let sha = null;
	try {
		sha = await getTagSha(ACTION_REPO, tag);
	} catch {
		sha = null;
	}
	return {
		tag,
		sha
	};
}
const majorOf = (tag) => tag.replace(/^v/, "").split(".")[0];
/** Evaluate a pin ref against the latest release; never throws. */
function evaluatePin(ref, latest) {
	if (SHA_RE.test(ref)) {
		const short = ref.slice(0, 12);
		if (latest?.sha && ref.toLowerCase() === latest.sha.toLowerCase()) return {
			stale: false,
			detail: `pinned to latest (${latest.tag} via SHA ${short})`
		};
		if (latest?.sha) return {
			stale: true,
			detail: `stale pin: SHA ${short} (latest ${latest.tag} = ${latest.sha.slice(0, 12)})`
		};
		return {
			stale: false,
			detail: `sha-pinned ${short} (cannot compare locally)`
		};
	}
	if (TAG_RE.test(ref)) {
		if (!latest) return {
			stale: false,
			detail: `pinned to ${ref} (latest unknown)`
		};
		if (ref === latest.tag) return {
			stale: false,
			detail: `pinned to ${ref} (latest)`
		};
		if (!ref.includes(".") && majorOf(ref) === majorOf(latest.tag)) return {
			stale: false,
			detail: `pinned to ${ref} (floating, latest ${latest.tag})`
		};
		return {
			stale: true,
			detail: `stale pin: ${ref} (latest ${latest.tag})`
		};
	}
	return {
		stale: false,
		detail: `unrecognized ref ${ref} (expected a tag or 40-hex SHA)`
	};
}
/**
* Compare the workspace trust binding (+ default branch) against live gh
* values. Returns drift descriptions (empty = no drift) and side notes.
*/
async function checkBindingDrift({ client, workspaces }, repo) {
	const workspace = findWorkspaceByRepoUrl(workspaces, repo.fullName);
	if (!workspace) return {
		drifts: [],
		notes: ["no margins workspace found for repo"]
	};
	let binding;
	try {
		binding = (await client.get(`/api/workspaces/${workspace.id}/binding`)).binding;
	} catch (err) {
		return {
			drifts: [],
			notes: [`binding check failed: ${err instanceof Error ? err.message : String(err)}`]
		};
	}
	if (binding === null) return {
		drifts: [],
		notes: ["workspace has no trust binding"]
	};
	const drifts = [];
	if (binding.boundRepoName !== repo.fullName) drifts.push(`renamed: bound ${binding.boundRepoName}, now ${repo.fullName}`);
	if (binding.repositoryOwnerId !== repo.ownerId) drifts.push(`transferred: owner id changed (bound ${binding.repositoryOwnerId}, now ${repo.ownerId})`);
	if (binding.githubRepoId !== repo.id) drifts.push(`repo id changed (bound ${binding.githubRepoId}, now ${repo.id})`);
	if (workspace.defaultBranch && workspace.defaultBranch !== repo.defaultBranch) drifts.push(`default branch changed: ${workspace.defaultBranch} → ${repo.defaultBranch}`);
	return {
		drifts,
		notes: []
	};
}
async function auditRepo(drift, target, latest) {
	let repo;
	try {
		repo = await getRepo(target);
	} catch (err) {
		if (err instanceof GhError) return {
			repo: target,
			status: "error",
			detail: `gh: ${err.message}`
		};
		throw err;
	}
	const [driftResult, caps] = await Promise.all([drift ? checkBindingDrift(drift, repo) : null, checkRepoCaps(repo.fullName, repo.defaultBranch)]);
	const workflow = caps.paths.has(".github/workflows/margins-sync.yml") ? await getFileContent(repo.fullName, WORKFLOW_PATH, repo.defaultBranch) : null;
	if (workflow === null) return {
		repo: repo.fullName,
		status: "missing",
		detail: `no ${WORKFLOW_PATH} on ${repo.defaultBranch}`
	};
	const findings = [];
	const notes = [];
	const ref = parseActionPin(workflow);
	if (ref === null) findings.push({
		status: "error",
		detail: `workflow present but no ${ACTION_REPO} pin found`
	});
	else {
		const pin = evaluatePin(ref, latest);
		if (pin.stale) findings.push({
			status: "stale-pin",
			detail: pin.detail
		});
		else notes.push(pin.detail);
	}
	if (driftResult) {
		for (const d of driftResult.drifts) findings.push({
			status: "binding-drift",
			detail: d
		});
		notes.push(...driftResult.notes);
	}
	if (caps.ok) notes.push(`${caps.syncableCount} syncable files`);
	else findings.push({
		status: "over-cap",
		detail: caps.reason
	});
	const status = [
		"binding-drift",
		"over-cap",
		"stale-pin",
		"error"
	].find((s) => findings.some((f) => f.status === s)) ?? "ok";
	const detail = status === "ok" ? notes.join("; ") : findings.map((f) => f.detail).join("; ");
	return {
		repo: repo.fullName,
		status,
		detail
	};
}
function csvField(value) {
	return /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}
function toCsv(rows) {
	return ["repo,status,detail", ...rows.map((r) => [
		r.repo,
		r.status,
		r.detail
	].map(csvField).join(","))].join("\n");
}
async function handleAudit(cfg, target, opts) {
	const hasMarginsAuth = Boolean(cfg.apiKey || cfg.refreshToken && cfg.keycloakIssuer);
	const client = hasMarginsAuth ? createApiClient(cfg) : null;
	let driftSkippedReason = hasMarginsAuth ? null : "no margins auth";
	const fetchWorkspaces = async () => {
		if (!client) return null;
		try {
			return await client.get("/api/workspaces");
		} catch (err) {
			driftSkippedReason = err instanceof Error ? err.message : String(err);
			return null;
		}
	};
	const [latest, workspaces, repos] = await Promise.all([
		resolveLatestAction(),
		fetchWorkspaces(),
		resolveRepoTargets(target, opts)
	]);
	if (repos.length === 0) {
		console.log(`No repos matched in ${opts.org}.`);
		return;
	}
	const drift = client && workspaces ? {
		client,
		workspaces
	} : null;
	const rows = await poolMap(repos, AUDIT_CONCURRENCY, async (repo) => {
		try {
			return await auditRepo(drift, repo, latest);
		} catch (err) {
			return {
				repo,
				status: "error",
				detail: err instanceof Error ? err.message : String(err)
			};
		}
	});
	const driftNote = driftSkippedReason ? `binding checks skipped (${driftSkippedReason})` : null;
	if (opts.csv) console.log(toCsv(rows));
	else if (cfg.json) console.log(formatJson({
		latestAction: latest?.tag ?? null,
		...driftNote ? { note: driftNote } : {},
		results: rows
	}));
	else {
		console.log(formatTable([
			"Repo",
			"Status",
			"Detail"
		], rows.map((r) => [
			r.repo,
			r.status,
			r.detail
		])));
		const counts = /* @__PURE__ */ new Map();
		for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
		const summary = [
			"ok",
			"missing",
			"stale-pin",
			"binding-drift",
			"over-cap",
			"error"
		].filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`).join(", ");
		console.log(`\n${summary} (latest action: ${latest?.tag ?? "unknown"})`);
		if (driftNote) console.log(driftNote);
	}
	if (rows.some((r) => r.status === "error")) process.exitCode = 1;
}

//#endregion
export { handleAudit };