#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";

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
	while (!fs.existsSync(path.join(dir, ".git"))) {
		const parent = path.dirname(dir);
		if (parent === dir) {
			console.error("Error: Not a git repository (no .git directory found).");
			process.exit(1);
		}
		dir = parent;
	}
	const hooksDir = path.join(dir, ".git", "hooks");
	const trigger = opts.on ?? "push";
	const hookName = trigger === "commit" ? "post-commit" : "pre-push";
	const hookPath = path.join(hooksDir, hookName);
	const hookContent = trigger === "commit" ? POST_COMMIT_HOOK : PRE_PUSH_HOOK;
	if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
	if (fs.existsSync(hookPath)) {
		if (!opts.force) {
			const overwrite = await p.confirm({ message: `${hookName} hook already exists. Overwrite?` });
			if (p.isCancel(overwrite) || !overwrite) {
				p.cancel("Hook installation cancelled.");
				process.exit(0);
			}
		}
	}
	fs.writeFileSync(hookPath, hookContent, { mode: 493 });
	console.log(`Installed ${hookName} hook at ${hookPath}`);
	if (!fs.existsSync(path.join(dir, ".margins.json"))) {
		console.warn(`Warning: .margins.json not found in ${dir}.`);
		console.warn(`Run \`margins sync\` first to register this folder and write .margins.json.`);
		console.warn(`Otherwise the hook will fail silently on every push.`);
	}
}

//#endregion
export { handleInstallHook };