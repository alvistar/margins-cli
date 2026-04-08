#!/usr/bin/env node
import { t as getGlobalConfig } from "./config-DHEPrW--.mjs";
import { i as maskKey, n as formatJson, r as formatTable } from "./output-Tt66fI4Y.mjs";

//#region src/commands/config/show.ts
function handleShow(opts) {
	const config = getGlobalConfig();
	const activeCredential = config.apiKey ?? config.accessToken;
	const masked = maskKey(activeCredential);
	const serverUrl = config.serverUrl ?? "(not set)";
	if (opts.json) return formatJson({
		apiKey: masked,
		serverUrl
	});
	return formatTable(["Setting", "Value"], [["API Key / Token", masked], ["Server URL", serverUrl]]) + (!activeCredential ? "\n  Run: margins auth login" : "");
}

//#endregion
export { handleShow };