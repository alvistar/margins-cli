#!/usr/bin/env node
import { i as setGlobalConfig } from "./config-BxDdM2BH.mjs";

//#region src/commands/config/set-key.ts
function handleSetKey(key) {
	setGlobalConfig({ apiKey: key });
}

//#endregion
export { handleSetKey };