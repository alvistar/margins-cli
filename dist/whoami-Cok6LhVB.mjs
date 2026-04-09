#!/usr/bin/env node
import { o as AuthMissing } from "./config-BxDdM2BH.mjs";
import { i as maskKey, n as formatJson, r as formatTable } from "./output-DYsHe1Ux.mjs";
import { t as createApiClient } from "./api-client-CMtOyXFg.mjs";
import * as p from "@clack/prompts";

//#region src/commands/auth/whoami.ts
async function handleWhoami(cfg) {
	if (!cfg.apiKey) throw new AuthMissing();
	const { user, key } = await createApiClient(cfg).get("/api/auth/whoami");
	const expiresAtHuman = key?.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "never";
	if (cfg.json) {
		console.log(formatJson({
			user: {
				name: user.name,
				email: user.email
			},
			key: key ? {
				label: key.label,
				role: key.role,
				expiresAt: key.expiresAt ?? null
			} : null
		}));
		return;
	}
	p.intro("Authenticated");
	const rows = [["Name", user.name ?? "(unknown)"], ["Email", user.email ?? "(unknown)"]];
	if (key) rows.push(["Key label", key.label ?? "(unlabeled)"], ["Role", key.role], ["API key", maskKey(cfg.apiKey)], ["Expires", expiresAtHuman], ["Last used", key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "never"]);
	else rows.push(["Auth method", "Browser session"]);
	console.log(formatTable(["Field", "Value"], rows));
}

//#endregion
export { handleWhoami };