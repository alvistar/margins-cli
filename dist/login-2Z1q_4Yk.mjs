#!/usr/bin/env node
import { i as setGlobalConfig, m as OAuthError, u as LoginTimeout } from "./config-DHEPrW--.mjs";
import * as http from "node:http";
import * as p from "@clack/prompts";
import * as oauth from "oauth4webapi";
import open from "open";

//#region src/commands/auth/login.ts
const LOGIN_TIMEOUT_MS = 120 * 1e3;
const PORT_RANGE_START = 9876;
const PORT_RANGE_END = 9886;
function randomPortStart() {
	const width = PORT_RANGE_END - PORT_RANGE_START + 1;
	return PORT_RANGE_START + Math.floor(Math.random() * width);
}
const SCOPES = "openid email profile offline_access";
function findAvailablePort(start, end) {
	return new Promise((resolve, reject) => {
		const tryPort = (port) => {
			if (port > end) {
				reject(/* @__PURE__ */ new Error("No available ports"));
				return;
			}
			const server = http.createServer();
			server.listen(port, "127.0.0.1", () => {
				server.close(() => resolve(port));
			});
			server.on("error", () => tryPort(port + 1));
		};
		tryPort(start);
	});
}
function waitForCallback(port, expectedState) {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const params = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).searchParams;
			const error = params.get("error");
			const errorDesc = params.get("error_description");
			const state = params.get("state");
			const code = params.get("code");
			server.close();
			const closeServer = () => server.closeAllConnections?.();
			if (error) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end("<html><body><h2>Login failed. Check the CLI for details.</h2></body></html>", () => {
					closeServer();
					reject(new OAuthError(errorDesc ?? error));
				});
				return;
			}
			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end("<html><body><h2>Login failed: security check failed.</h2></body></html>", () => {
					closeServer();
					reject(new OAuthError("Security error: state mismatch. Try again."));
				});
				return;
			}
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end("<html><body><h2>Login failed: no authorization code received.</h2></body></html>", () => {
					closeServer();
					reject(/* @__PURE__ */ new Error("No code in callback"));
				});
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html" });
			resolve(params);
			res.end("<html><body><h2>Login complete. You can close this tab.</h2></body></html>", closeServer);
		});
		server.listen(port, "127.0.0.1");
		server.on("error", reject);
	});
}
async function handleLogin(cfg) {
	const serverUrl = cfg.serverUrl;
	let issuerUrl;
	let clientId;
	try {
		const res = await fetch(`${serverUrl}/api/auth/cli-config`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();
		issuerUrl = new URL(json.issuer);
		clientId = json.clientId;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		p.log.warning(`Could not fetch config from ${serverUrl}/api/auth/cli-config: ${reason}`);
		p.log.info(`Make sure your server URL is set correctly: margins config set-url <url>`);
		const issuer = await p.text({
			message: "Enter Keycloak issuer URL (e.g. https://auth.example.com/realms/margins)",
			validate: (v) => {
				try {
					new URL(v);
					return;
				} catch {
					return "Invalid URL";
				}
			}
		});
		if (p.isCancel(issuer)) {
			p.cancel("Login cancelled");
			process.exit(0);
		}
		issuerUrl = new URL(issuer);
		clientId = "margins-cli";
	}
	const startPort = randomPortStart();
	const port = await findAvailablePort(startPort, PORT_RANGE_END).catch(() => findAvailablePort(PORT_RANGE_START, startPort - 1));
	const redirectUri = `http://127.0.0.1:${port}/callback`;
	const as = await oauth.discoveryRequest(issuerUrl, { algorithm: "oidc" }).then((r) => oauth.processDiscoveryResponse(issuerUrl, r));
	const codeVerifier = oauth.generateRandomCodeVerifier();
	const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
	const state = oauth.generateRandomState();
	if (!as.authorization_endpoint) throw new OAuthError("Keycloak discovery did not return an authorization_endpoint");
	const authUrl = new URL(as.authorization_endpoint);
	authUrl.searchParams.set("client_id", clientId);
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("scope", SCOPES);
	authUrl.searchParams.set("code_challenge", codeChallenge);
	authUrl.searchParams.set("code_challenge_method", "S256");
	authUrl.searchParams.set("state", state);
	p.intro("Logging in to Margins");
	const spinner = p.spinner();
	spinner.start("Opening browser...");
	try {
		await open(authUrl.toString());
		spinner.stop("Browser opened. Complete login in your browser.");
	} catch {
		spinner.stop(`Couldn't open browser. Open this URL manually:\n  ${authUrl.toString()}`);
	}
	let loginTimeoutId;
	const callbackParams = await Promise.race([waitForCallback(port, state), new Promise((_, reject) => {
		loginTimeoutId = setTimeout(() => reject(new LoginTimeout()), LOGIN_TIMEOUT_MS);
	})]).finally(() => clearTimeout(loginTimeoutId));
	spinner.start("Completing authentication...");
	const client = {
		client_id: clientId,
		token_endpoint_auth_method: "none"
	};
	let params;
	try {
		params = oauth.validateAuthResponse(as, client, callbackParams, state);
	} catch (err) {
		throw new OAuthError(err instanceof Error ? err.message : String(err));
	}
	const tokenResponse = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, redirectUri, codeVerifier);
	const result = await oauth.processAuthorizationCodeResponse(as, client, tokenResponse);
	const accessToken = result.access_token;
	const refreshToken = result.refresh_token;
	const expiresIn = result.expires_in ?? 300;
	const accessTokenExpiresAt = Date.now() + expiresIn * 1e3;
	setGlobalConfig({
		accessToken,
		refreshToken: refreshToken ?? void 0,
		accessTokenExpiresAt,
		keycloakIssuer: issuerUrl.toString(),
		keycloakClientId: clientId,
		apiKey: void 0
	});
	spinner.stop("Logged in successfully. Session saved.");
	p.outro(refreshToken ? `Session active. Refresh token stored — you will not need to log in again for a while.` : `Session active. No refresh token — you may need to log in again when the session expires.`);
}

//#endregion
export { handleLogin };