#!/usr/bin/env node
import { i as setGlobalConfig } from "./config-DHEPrW--.mjs";

//#region src/commands/config/set-url.ts
function handleSetUrl(url) {
	setGlobalConfig({ serverUrl: url });
}

//#endregion
export { handleSetUrl };