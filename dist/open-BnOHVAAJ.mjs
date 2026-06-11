#!/usr/bin/env node
import { n as readLocalConfig, v as ValidationError } from "./config-DqP75CeC.mjs";
import { t as open } from "./open-Cc9SU1qE.mjs";

//#region src/commands/workspace/open.ts
async function handleOpen(cfg, slug) {
	const resolvedSlug = slug ?? readLocalConfig()?.workspace_slug;
	if (!resolvedSlug) throw new ValidationError("No workspace specified. Pass a slug or create .margins.json");
	const url = `${cfg.serverUrl}/w/${resolvedSlug}`;
	await open(url);
	console.log(`Opening: ${url}`);
}

//#endregion
export { handleOpen };