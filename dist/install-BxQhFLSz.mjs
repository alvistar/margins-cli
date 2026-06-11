#!/usr/bin/env node
import { s as ConflictError } from "./config-DqP75CeC.mjs";
import { n as formatJson, r as formatTable } from "./output-EDs_B5hm.mjs";
import { t as createApiClient } from "./api-client-Dj9rmGKx.mjs";
import { _ as putFile, a as findWorkspaceByRepoUrl, c as createBranch, f as getFileSha, i as checkRepoCaps, l as createPullRequest, m as getRepo, n as stampTemplate, o as GhError, r as resolveRepoTargets, s as branchExists, t as WORKFLOW_PATH, u as getBranchSha } from "./margins-sync-Cy8VHxPQ.mjs";

//#region src/commands/install.ts
/** Branch the workflow PR is opened from. */
const INSTALL_BRANCH = "margins/install-sync";
/** Max seconds we honor from a rate-limit Retry-After before capping. */
const MAX_RETRY_AFTER_S = 300;
function prBody(fullName, workspaceId, serverUrl) {
	return `## Margins sync — credentialless setup

This PR adds a workflow that syncs this repo's markdown (and referenced images)
to its Margins workspace on every merge to the default branch.

**No secrets are stored anywhere.** The workflow authenticates with a
short-lived GitHub OIDC token (\`permissions: id-token: write\`): GitHub signs a
~5-minute JWT proving this repo's identity, and the Margins server verifies it
against a trust binding pinned to this repo's immutable GitHub IDs. There is no
Margins API key in this repo, and Margins holds no GitHub credential.

- Workspace: \`${workspaceId}\` on ${serverUrl}
- Trust binding: ${fullName} (already enabled server-side by \`margins install\`)
- How it works: https://github.com/alvistar/margins-sync-action#readme

Merging this PR activates sync. Until the first workflow push succeeds, manual
\`margins workspace push\` still works.
`;
}
async function processRepo(client, cfg, workspaces, target, dryRun) {
	const actions = [];
	const result = (status, reason) => ({
		repo: target,
		status,
		actions,
		...reason ? { reason } : {}
	});
	let repo;
	try {
		repo = await getRepo(target);
	} catch (err) {
		if (err instanceof GhError && err.status !== 403) return result("failed", `gh: ${err.message}`);
		throw err;
	}
	const fullName = repo.fullName;
	const repoUrl = `https://github.com/${fullName}`;
	const caps = await checkRepoCaps(fullName, repo.defaultBranch);
	if (!caps.ok) return result("skipped", caps.reason);
	actions.push(`pre-check ok (${caps.syncableCount} syncable files)`);
	const workspace = findWorkspaceByRepoUrl(workspaces, fullName);
	if (workspace && workspace.syncMode !== "client") return result("skipped", `workspace ${workspace.slug} uses syncMode "${workspace.syncMode}" — migrate it to client sync first (never silently bound)`);
	let workspaceId;
	if (workspace) {
		workspaceId = workspace.id;
		actions.push(`workspace exists (${workspace.slug})`);
	} else if (dryRun) {
		actions.push(`would create workspace (source: github, syncMode: client, repoUrl: ${repoUrl})`);
		workspaceId = "<new-workspace-id>";
	} else {
		const name = fullName.split("/")[1];
		const created = await client.post("/api/workspaces", {
			name,
			source: "github",
			repoUrl,
			branch: repo.defaultBranch,
			syncMode: "client"
		});
		const ws = "workspace" in created ? created.workspace : created;
		workspaceId = ws.id;
		workspaces.push({
			id: ws.id,
			slug: ws.slug,
			name,
			repoUrl,
			syncMode: "client",
			defaultBranch: repo.defaultBranch
		});
		actions.push(`workspace created (${ws.slug})`);
	}
	const wouldEnableBinding = `would enable binding (repoId ${repo.id}, ownerId ${repo.ownerId}, ${fullName})`;
	if (workspace || !dryRun) {
		const { binding } = await client.get(`/api/workspaces/${workspaceId}/binding`);
		if (binding === null) if (dryRun) actions.push(wouldEnableBinding);
		else try {
			await client.put(`/api/workspaces/${workspaceId}/binding`, {
				githubRepoId: repo.id,
				repositoryOwnerId: repo.ownerId,
				boundRepoName: fullName
			});
			actions.push("binding enabled");
		} catch (err) {
			if (err instanceof ConflictError) return result("failed", "binding conflict (BINDING_CONFLICT) — another repo is bound; run audit / reset the binding first");
			throw err;
		}
		else if (binding.githubRepoId === repo.id && binding.repositoryOwnerId === repo.ownerId && binding.boundRepoName === fullName) actions.push("binding already enabled (matches)");
		else return result("failed", `binding mismatch: workspace is bound to ${binding.boundRepoName} (repoId ${binding.githubRepoId}) — reset the binding before reinstalling`);
	} else actions.push(wouldEnableBinding);
	if (caps.paths.has(".github/workflows/margins-sync.yml")) {
		actions.push("workflow already present");
		return result("installed");
	}
	const stamped = stampTemplate({
		defaultBranch: repo.defaultBranch,
		serverUrl: cfg.serverUrl,
		workspaceId
	});
	if (dryRun) {
		actions.push(`would open PR adding ${WORKFLOW_PATH} (branch ${INSTALL_BRANCH}, base ${repo.defaultBranch})`);
		return result("installed");
	}
	try {
		let branchCreated = false;
		if (!await branchExists(fullName, INSTALL_BRANCH)) {
			const baseSha = await getBranchSha(fullName, repo.defaultBranch);
			await createBranch(fullName, INSTALL_BRANCH, baseSha);
			actions.push(`branch ${INSTALL_BRANCH} created`);
			branchCreated = true;
		}
		if ((branchCreated ? null : await getFileSha(fullName, ".github/workflows/margins-sync.yml", INSTALL_BRANCH)) === null) {
			await putFile(fullName, {
				path: WORKFLOW_PATH,
				branch: INSTALL_BRANCH,
				message: "ci: add Margins credentialless sync workflow",
				contentBase64: Buffer.from(stamped, "utf-8").toString("base64")
			});
			actions.push("workflow file committed");
		}
		const pr = await createPullRequest(fullName, {
			title: "Add Margins credentialless sync workflow",
			head: INSTALL_BRANCH,
			base: repo.defaultBranch,
			body: prBody(fullName, workspaceId, new URL(cfg.serverUrl).origin)
		});
		actions.push(`PR opened: ${pr.url}`);
		return result("installed");
	} catch (err) {
		if (err instanceof GhError) {
			if (err.status === 422 && /already exists/i.test(err.message)) {
				actions.push("PR already open");
				return result("installed");
			}
			if (err.status === 403 && err.retryAfter != null) throw err;
			if (err.status === 403 || err.status === 404) return result("skipped", "PR creation blocked, awaiting permissions");
			return result("failed", `gh: ${err.message}`);
		}
		throw err;
	}
}
async function handleInstall(cfg, target, opts) {
	const dryRun = opts.dryRun ?? false;
	const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const client = createApiClient(cfg);
	const repos = await resolveRepoTargets(target, opts);
	if (repos.length === 0) {
		console.log(`No repos matched in ${opts.org}.`);
		return;
	}
	const workspaces = await client.get("/api/workspaces");
	const results = [];
	for (const repo of repos) {
		let rateLimitRetried = false;
		for (;;) {
			try {
				results.push(await processRepo(client, cfg, workspaces, repo, dryRun));
			} catch (err) {
				if (err instanceof GhError && err.status === 403 && !rateLimitRetried) {
					rateLimitRetried = true;
					const waitS = Math.min(err.retryAfter ?? 60, MAX_RETRY_AFTER_S);
					console.error(`Rate limited on ${repo} — waiting ${waitS}s before retrying...`);
					await sleep(waitS * 1e3);
					continue;
				}
				if (err instanceof GhError) results.push({
					repo,
					status: "failed",
					actions: [],
					reason: `gh: ${err.message}`
				});
				else if (opts.org) {
					const message = err instanceof Error ? err.message : String(err);
					results.push({
						repo,
						status: "failed",
						actions: [],
						reason: message
					});
				} else throw err;
			}
			break;
		}
	}
	if (cfg.json) console.log(formatJson({
		dryRun,
		results
	}));
	else {
		if (dryRun) console.log("Dry run — no changes were made.\n");
		for (const r of results) for (const a of r.actions) console.log(`  ${r.repo}: ${a}`);
		console.log("");
		console.log(formatTable([
			"Repo",
			"Status",
			"Reason"
		], results.map((r) => [
			r.repo,
			r.status,
			r.reason ?? ""
		])));
		const counts = {
			installed: 0,
			skipped: 0,
			failed: 0
		};
		for (const r of results) counts[r.status]++;
		console.log(`\n${counts.installed} installed, ${counts.skipped} skipped, ${counts.failed} failed`);
	}
	if (results.some((r) => r.status === "failed")) process.exitCode = 1;
}

//#endregion
export { handleInstall };