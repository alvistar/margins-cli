#!/usr/bin/env node
import { i as setGlobalConfig, o as AuthMissing } from "./config-DqP75CeC.mjs";
import { n as formatJson } from "./output-EDs_B5hm.mjs";
import { c as processDiscoveryResponse, d as revocationRequest, i as discoveryRequest, t as None } from "./build-DpfH9kc6.mjs";
import { r as R, t as Gt } from "./dist-DRq_WvKJ.mjs";

//#region src/commands/auth/logout.ts
async function handleLogout(cfg) {
	if (!cfg.apiKey && !cfg.refreshToken) throw new AuthMissing();
	let tokenRevoked = false;
	if (cfg.refreshToken && cfg.keycloakIssuer && cfg.keycloakClientId) try {
		const issuerUrl = new URL(cfg.keycloakIssuer);
		const as = await discoveryRequest(issuerUrl, { algorithm: "oidc" }).then((r) => processDiscoveryResponse(issuerUrl, r));
		const client = {
			client_id: cfg.keycloakClientId,
			token_endpoint_auth_method: "none"
		};
		if (as.revocation_endpoint) {
			await revocationRequest(as, client, None(), cfg.refreshToken);
			tokenRevoked = true;
		}
	} catch {
		if (cfg.json) process.stderr.write(JSON.stringify({ warning: "Could not revoke session on Keycloak — cleared locally only" }) + "\n");
		else R.warning("Could not revoke session on Keycloak — cleared locally only");
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
	Gt("Logged out. Session cleared.");
}

//#endregion
export { handleLogout };