#!/usr/bin/env node
import { _ as TimeoutError, a as AuthExpired, f as NetworkError, g as ServerError, h as ResponseParseError, i as setGlobalConfig, l as ForbiddenError, p as NotFoundError, s as ConflictError } from "./config-BxDdM2BH.mjs";
import { i as maskKey } from "./output-DYsHe1Ux.mjs";
import * as oauth from "oauth4webapi";

//#region src/lib/api-client.ts
const DEFAULT_TIMEOUT_MS = 3e4;
const REFRESH_BUFFER_MS = 3e4;
async function refreshAccessToken(cfg) {
	if (!cfg.refreshToken || !cfg.keycloakIssuer || !cfg.keycloakClientId) throw new AuthExpired();
	const issuerUrl = new URL(cfg.keycloakIssuer);
	const as = await oauth.discoveryRequest(issuerUrl, { algorithm: "oidc" }).then((r) => oauth.processDiscoveryResponse(issuerUrl, r));
	const client = {
		client_id: cfg.keycloakClientId,
		token_endpoint_auth_method: "none"
	};
	const response = await oauth.refreshTokenGrantRequest(as, client, oauth.None(), cfg.refreshToken);
	let result;
	try {
		result = await oauth.processRefreshTokenResponse(as, client, response);
	} catch {
		throw new AuthExpired();
	}
	const newAccessToken = result.access_token;
	const expiresIn = result.expires_in ?? 300;
	setGlobalConfig({
		accessToken: newAccessToken,
		accessTokenExpiresAt: Date.now() + expiresIn * 1e3,
		...result.refresh_token ? { refreshToken: result.refresh_token } : {}
	});
	return newAccessToken;
}
/**
* Returns the current access token, refreshing it first if it's expired or close
* to expiry. Falls back to the stored apiKey if no Keycloak session is present.
*/
async function resolveBearer(cfg) {
	if (cfg.refreshToken && cfg.keycloakIssuer && cfg.accessTokenExpiresAt) {
		if (Date.now() >= cfg.accessTokenExpiresAt - REFRESH_BUFFER_MS) return refreshAccessToken(cfg);
	}
	return cfg.apiKey ?? "";
}
function createApiClient(config) {
	function buildUrl(path, query) {
		const base = config.serverUrl.replace(/\/$/, "");
		const url = new URL(`${base}${path}`);
		if (query) {
			for (const [k, v] of Object.entries(query)) if (v !== void 0) url.searchParams.set(k, v);
		}
		return url.toString();
	}
	function log(msg) {
		if (config.verbose) process.stderr.write(`[margins] ${msg}\n`);
	}
	async function doFetch(method, path, query, body, attempt = 1) {
		const url = buildUrl(path, query);
		const bearer = await resolveBearer(config);
		const headers = {
			Authorization: `Bearer ${bearer}`,
			Accept: "application/json",
			...body !== void 0 ? { "Content-Type": "application/json" } : {}
		};
		log(`${method} ${url} (key: ${maskKey(bearer)})`);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		let response;
		try {
			response = await fetch(url, {
				method,
				headers,
				body: body !== void 0 ? JSON.stringify(body) : void 0,
				signal: controller.signal
			});
		} catch (err) {
			clearTimeout(timer);
			if (err.name === "AbortError") {
				if ((method === "GET" || method === "DELETE") && attempt < 2) {
					log("Timeout — retrying once...");
					return doFetch(method, path, query, body, attempt + 1);
				}
				throw new TimeoutError();
			}
			throw new NetworkError(config.serverUrl);
		}
		clearTimeout(timer);
		log(`→ ${response.status}`);
		if (response.status === 401) throw new AuthExpired();
		if (response.status === 403) throw new ForbiddenError(path);
		if (response.status === 404) throw new NotFoundError(path);
		if (response.status === 409) throw new ConflictError(`Conflict while calling ${path}`);
		if (response.status >= 400 && response.status < 500) throw new ServerError(response.status);
		if (response.status >= 500) throw new ServerError(response.status);
		const text = await response.text();
		if (!text) return {};
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new ResponseParseError();
		}
		if (parsed !== null && typeof parsed === "object" && "data" in parsed) return parsed.data;
		return parsed;
	}
	return {
		get: (path, query) => doFetch("GET", path, query),
		post: (path, body) => doFetch("POST", path, void 0, body),
		patch: (path, body) => doFetch("PATCH", path, void 0, body),
		delete: (path) => doFetch("DELETE", path)
	};
}

//#endregion
export { createApiClient as t };