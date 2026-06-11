#!/usr/bin/env node
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

//#region src/lib/version.ts
const __dirname = dirname(fileURLToPath(import.meta.url));
/**
* Resolve the CLI's own version from package.json (same source `--version`
* uses in src/index.ts). Two candidate paths because this module lives at
* `dist/` (bundled, package.json one level up) in releases and at `src/lib/`
* (two levels up) in dev/tests.
*/
function readVersion() {
	for (const rel of ["../package.json", "../../package.json"]) try {
		const pkg = JSON.parse(readFileSync(join(__dirname, rel), "utf-8"));
		if (pkg.name === "margins-cli" && pkg.version) return pkg.version;
	} catch {}
	return "0.0.0";
}
const CLI_VERSION = readVersion();

//#endregion
export { CLI_VERSION as t };