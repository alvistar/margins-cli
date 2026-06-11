#!/usr/bin/env node
import { i as setGlobalConfig } from "./config-DqP75CeC.mjs";

//#region src/commands/config/set-key.ts
function handleSetKey(key) {
	setGlobalConfig({ apiKey: key });
}

//#endregion
export { handleSetKey };