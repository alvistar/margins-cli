#!/usr/bin/env node
import { i as setGlobalConfig, o as AuthMissing } from "./config-BxDdM2BH.mjs";
import { n as formatJson } from "./output-DYsHe1Ux.mjs";
import * as p from "@clack/prompts";
import * as oauth from "oauth4webapi";

//#region src/commands/auth/logout.ts
async function handleLogout(cfg) {
	if (!cfg.apiKey && !cfg.refreshToken) throw new AuthMissing();
	let tokenRevoked = false;
	if (cfg.refreshToken && cfg.keycloakIssuer && cfg.keycloakClientId) try {
		const issuerUrl = new URL(cfg.keycloakIssuer);
		const as = await oauth.discoveryRequest(issuerUrl, { algorithm: "oidc" }).then((r) => oauth.processDiscoveryResponse(issuerUrl, r));
		const client = {
			client_id: cfg.keycloakClientId,
			token_endpoint_auth_method: "none"
		};
		if (as.revocation_endpoint) {
			await oauth.revocationRequest(as, client, oauth.None(), cfg.refreshToken);
			tokenRevoked = true;
		}
	} catch {
		if (cfg.json) process.stderr.write(JSON.stringify({ warning: "Could not revoke session on Keycloak — cleared locally only" }) + "\n");
		else p.log.warning("Could not revoke session on Keycloak — cleared locally only");
	}
	setGlobalConfig({
		apiKey: void 0,
		accessToken: void 0,
		refreshToken: void 0,
		accessTokenExpiresAt: void 0,
		keycloakIssuer: void 0,
		keycloakClientId: void 0
	});
	if (cfg.json) {
		console.log(formatJson({
			loggedOut: true,
			tokenRevoked
		}));
		return;
	}
	p.outro("Logged out. Session cleared.");
}

//#endregion
export { handleLogout };