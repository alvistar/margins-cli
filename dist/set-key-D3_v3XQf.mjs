#!/usr/bin/env node
import { i as setGlobalConfig } from "./config-NcAwuGj_.mjs";

//#region src/commands/config/set-key.ts
function handleSetKey(key) {
	setGlobalConfig({ apiKey: key });
}

//#endregion
export { handleSetKey };