#!/usr/bin/env node
import { c as DiscussionNotFoundError, n as readLocalConfig, p as NotFoundError, s as ConflictError, v as ValidationError } from "./config-DHEPrW--.mjs";
import { n as formatJson } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";
import { t as resolveWorkspaceBySlug } from "./resolve-workspace-CCRy89Zw.mjs";

//#region src/commands/discuss/resolve.ts
async function handleDiscussResolve(cfg, discussionId, opts) {
	const resolvedSlug = opts.workspace ?? readLocalConfig()?.workspace_slug;
	if (!resolvedSlug) throw new ValidationError("No workspace specified. Pass --workspace <slug> or create .margins.json");
	const client = createApiClient(cfg);
	const workspace = await resolveWorkspaceBySlug(client, resolvedSlug);
	let updated;
	try {
		updated = await client.patch(`/api/workspaces/${workspace.id}/discussions/${discussionId}`, {
			status: "resolved",
			resolutionSummary: opts.summary ?? ""
		});
	} catch (err) {
		if (err instanceof ConflictError) {
			console.log(`Discussion ${discussionId} is already resolved.`);
			return;
		}
		if (err instanceof NotFoundError) throw new DiscussionNotFoundError(discussionId);
		throw err;
	}
	if (cfg.json) {
		console.log(formatJson(updated));
		return;
	}
	console.log(`Discussion ${discussionId} resolved.`);
}

//#endregion
export { handleDiscussResolve };