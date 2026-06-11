#!/usr/bin/env node
import { i as setGlobalConfig } from "./config-NcAwuGj_.mjs";

//#region src/commands/config/set-url.ts
function handleSetUrl(url) {
	setGlobalConfig({ serverUrl: url });
}

//#endregion
export { handleSetUrl };