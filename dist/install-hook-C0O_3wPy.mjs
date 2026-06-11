#!/usr/bin/env node
import { c as Ct, i as Rt, n as Nt } from "./dist-DRq_WvKJ.mjs";
import * as path$1 from "node:path";
import * as fs$1 from "node:fs";

//#region src/commands/install-hook.ts
/**
* `margins install-hook` — Install a git hook that syncs to Margins on push/commit.
*
* By default installs a pre-push hook. With `--on commit`, installs a post-commit hook.
* The hook runs `margins push` in the background so it never blocks git operations.
*/
const PRE_PUSH_HOOK = `#!/bin/sh
# Margins CAS sync — non-blocking pre-push hook
# Installed by: margins install-hook
# Reads workspace_id from .margins.json. Branch is detected from git automatically.
margins workspace push &
exit 0
`;
const POST_COMMIT_HOOK = `#!/bin/sh
# Margins CAS sync — non-blocking post-commit hook
# Installed by: margins install-hook --on commit
# Reads workspace_id from .margins.json. Branch is detected from git automatically.
margins workspace push &
exit 0
`;
async function handleInstallHook(opts) {
	let dir = process.cwd();
	while (!fs$1.existsSync(path$1.join(dir, ".git"))) {
		const parent = path$1.dirname(dir);
		if (parent === dir) {
			console.error("Error: Not a git repository (no .git directory found).");
			process.exit(1);
		}
		dir = parent;
	}
	const configPath = path$1.join(dir, ".margins.json");
	if (fs$1.existsSync(configPath)) try {
		const config = JSON.parse(fs$1.readFileSync(configPath, "utf-8"));
		if ((config.syncMode ?? (config.mode === "local" ? "client" : void 0)) === "server") {
			console.log("This workspace syncs via GitHub webhook — no hook needed.");
			console.log("Content is pulled by the server automatically on push.");
			return;
		}
	} catch {}
	const hooksDir = path$1.join(dir, ".git", "hooks");
	const trigger = opts.on ?? "push";
	const hookName = trigger === "commit" ? "post-commit" : "pre-push";
	const hookPath = path$1.join(hooksDir, hookName);
	const hookContent = trigger === "commit" ? POST_COMMIT_HOOK : PRE_PUSH_HOOK;
	if (!fs$1.existsSync(hooksDir)) fs$1.mkdirSync(hooksDir, { recursive: true });
	if (fs$1.existsSync(hookPath)) {
		if (!opts.force) {
			const overwrite = await Rt({ message: `${hookName} hook already exists. Overwrite?` });
			if (Ct(overwrite) || !overwrite) {
				Nt("Hook installation cancelled.");
				process.exit(0);
			}
		}
	}
	fs$1.writeFileSync(hookPath, hookContent, { mode: 493 });
	console.log(`Installed ${hookName} hook at ${hookPath}`);
	if (!fs$1.existsSync(configPath)) {
		console.warn(`Warning: .margins.json not found in ${dir}.`);
		console.warn(`Run \`margins sync\` first to register this folder and write .margins.json.`);
		console.warn(`Otherwise the hook will fail silently on every push.`);
	}
}

//#endregion
export { handleInstallHook };