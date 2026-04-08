#!/usr/bin/env node
import { c as DiscussionNotFoundError, n as readLocalConfig, p as NotFoundError, v as ValidationError } from "./config-DHEPrW--.mjs";
import { n as formatJson } from "./output-Tt66fI4Y.mjs";
import { t as createApiClient } from "./api-client-C6k_lE47.mjs";
import { t as resolveWorkspaceBySlug } from "./resolve-workspace-CCRy89Zw.mjs";

//#region src/commands/discuss/reply.ts
async function handleDiscussReply(cfg, discussionId, opts) {
	const resolvedSlug = opts.workspace ?? readLocalConfig()?.workspace_slug;
	if (!resolvedSlug) throw new ValidationError("No workspace specified. Pass --workspace <slug> or create .margins.json");
	const client = createApiClient(cfg);
	const workspace = await resolveWorkspaceBySlug(client, resolvedSlug);
	let reply;
	try {
		reply = await client.post(`/api/workspaces/${workspace.id}/discussions/${discussionId}/reply`, { body: opts.body });
	} catch (err) {
		if (err instanceof NotFoundError) throw new DiscussionNotFoundError(discussionId);
		throw err;
	}
	if (cfg.json) {
		console.log(formatJson(reply));
		return;
	}
	console.log(`Reply added to discussion ${discussionId}.`);
}

//#endregion
export { handleDiscussReply };