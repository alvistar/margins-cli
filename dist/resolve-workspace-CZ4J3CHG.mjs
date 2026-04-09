#!/usr/bin/env node
import { p as NotFoundError, y as WorkspaceNotFoundError } from "./config-BxDdM2BH.mjs";

//#region src/lib/resolve-workspace.ts
/**
* Resolve a workspace slug to its { id } by calling GET /api/workspaces/by-slug/:slug.
*
* Handles both response shapes the server has returned:
*   - flat:    { id, slug, ... }
*   - wrapped: { workspace: { id, slug, ... } }
*
* Throws WorkspaceNotFoundError if:
*   - the server returns 404
*   - the response is present but contains no id (unexpected shape)
*/
async function resolveWorkspaceBySlug(client, slug) {
	let raw;
	try {
		raw = await client.get(`/api/workspaces/by-slug/${slug}`);
	} catch (err) {
		if (err instanceof NotFoundError) throw new WorkspaceNotFoundError(slug);
		throw err;
	}
	const workspace = raw !== null && typeof raw === "object" && "workspace" in raw && typeof raw.workspace === "object" ? raw.workspace : raw;
	if (!workspace?.id) throw new WorkspaceNotFoundError(slug);
	return workspace;
}

//#endregion
export { resolveWorkspaceBySlug as t };