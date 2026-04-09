#!/usr/bin/env node
import { c as DiscussionNotFoundError, n as readLocalConfig, p as NotFoundError, v as ValidationError } from "./config-BxDdM2BH.mjs";
import { n as formatJson } from "./output-DYsHe1Ux.mjs";
import { t as createApiClient } from "./api-client-CMtOyXFg.mjs";
import { t as resolveWorkspaceBySlug } from "./resolve-workspace-CZ4J3CHG.mjs";

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