#!/usr/bin/env node
import { i as setGlobalConfig } from "./config-BxDdM2BH.mjs";

//#region src/commands/config/set-url.ts
function handleSetUrl(url) {
	setGlobalConfig({ serverUrl: url });
}

//#endregion
export { handleSetUrl };