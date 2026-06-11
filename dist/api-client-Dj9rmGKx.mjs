#!/usr/bin/env node
import { _ as TimeoutError, a as AuthExpired, f as NetworkError, g as ServerError, h as ResponseParseError, i as setGlobalConfig, l as ForbiddenError, p as NotFoundError, s as ConflictError } from "./config-DqP75CeC.mjs";
import { i as maskKey } from "./output-EDs_B5hm.mjs";
import { t as CLI_VERSION } from "./version-6-wxs6mz.mjs";
import { c as processDiscoveryResponse, i as discoveryRequest, l as processRefreshTokenResponse, t as None, u as refreshTokenGrantRequest } from "./build-DpfH9kc6.mjs";

//#region src/lib/api-client.ts
const DEFAULT_TIMEOUT_MS = 3e4;
const CLIENT_HEADER = `margins-cli/${CLI_VERSION}`;
const REFRESH_BUFFER_MS = 3e4;
async function refreshAccessToken(cfg) {
	if (!cfg.refreshToken || !cfg.keycloakIssuer || !cfg.keycloakClientId) throw new AuthExpired();
	const issuerUrl = new URL(cfg.keycloakIssuer);
	const as = await discoveryRequest(issuerUrl, { algorithm: "oidc" }).then((r) => processDiscoveryResponse(issuerUrl, r));
	const client = {
		client_id: cfg.keycloakClientId,
		token_endpoint_auth_method: "none"
	};
	const response = await refreshTokenGrantRequest(as, client, None(), cfg.refreshToken);
	let result;
	try {
		result = await processRefreshTokenResponse(as, client, response);
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
	let mintedOidcToken;
	const maskRegistered = /* @__PURE__ */ new Set();
	function currentOidcToken() {
		return mintedOidcToken ?? process.env["MARGINS_OIDC_TOKEN"] ?? void 0;
	}
	/** Register a token with GitHub Actions log masking before it's ever used. */
	function registerActionsMask(token) {
		if (process.env["GITHUB_ACTIONS"] && !maskRegistered.has(token)) {
			maskRegistered.add(token);
			process.stdout.write(`::add-mask::${token}\n`);
		}
	}
	function canRemintOidc() {
		return Boolean(process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] && process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]);
	}
	/**
	* Re-mint a GitHub Actions OIDC token (a long push can outlive the ~5-min
	* JWT validity). Audience = the server origin, no trailing slash — must
	* match the server's exact-string audience pin.
	*/
	async function remintOidcToken() {
		const requestUrl = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
		const requestToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
		const audience = new URL(config.serverUrl).origin;
		log("401 — re-minting GitHub Actions OIDC token...");
		let response;
		try {
			response = await fetch(`${requestUrl}&audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `Bearer ${requestToken}` } });
		} catch {
			throw new AuthExpired();
		}
		if (!response.ok) throw new AuthExpired();
		const result = await response.json().catch(() => null);
		if (!result?.value) throw new AuthExpired();
		registerActionsMask(result.value);
		mintedOidcToken = result.value;
	}
	/**
	* Resolve the bearer for a request. MARGINS_OIDC_TOKEN (or a re-minted
	* Actions token) takes precedence over Keycloak/api-key resolution.
	*/
	async function resolveRequestBearer() {
		const oidc = currentOidcToken();
		if (oidc) {
			registerActionsMask(oidc);
			return oidc;
		}
		return resolveBearer(config);
	}
	/** Extract the server error code from an error response body, if any. */
	async function readErrorCode(response) {
		try {
			const parsed = await response.json();
			if (parsed && typeof parsed.error === "object" && parsed.error?.code) return parsed.error.code;
			if (parsed?.code) return parsed.code;
		} catch {}
	}
	/** Map an error response status to the matching typed error. */
	async function throwForStatus(response, path) {
		if (response.status === 403) throw new ForbiddenError(path);
		if (response.status === 404) throw new NotFoundError(path);
		if (response.status === 409) throw new ConflictError(`Conflict while calling ${path}`);
		if (response.status >= 400) throw new ServerError(response.status, await readErrorCode(response));
	}
	/**
	* Send a request; on a 401 in GitHub Actions (where the ~5-min OIDC JWT can
	* expire mid-push), re-mint the token once and resend. Any remaining 401 is
	* AuthExpired. `send` resolves the bearer itself, so the resend picks up the
	* freshly minted token.
	*/
	async function sendWithOidcRemint(send) {
		let response = await send();
		if (response.status === 401 && canRemintOidc()) {
			await remintOidcToken();
			response = await send();
		}
		if (response.status === 401) throw new AuthExpired();
		return response;
	}
	/** Parse a JSON body, unwrapping the server's { data: ... } apiOk() envelope. */
	async function parseBody(response) {
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
	/** fetch with the default timeout; maps aborts/failures to typed errors. */
	async function fetchWithTimeout(url, init) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		try {
			return await fetch(url, {
				...init,
				signal: controller.signal
			});
		} catch (err) {
			if (err.name === "AbortError") throw new TimeoutError();
			throw new NetworkError(config.serverUrl);
		} finally {
			clearTimeout(timer);
		}
	}
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
		let response;
		try {
			response = await sendWithOidcRemint(async () => {
				const bearer = await resolveRequestBearer();
				log(`${method} ${url} (key: ${maskKey(bearer)})`);
				const sent = await fetchWithTimeout(url, {
					method,
					headers: {
						Authorization: `Bearer ${bearer}`,
						Accept: "application/json",
						"X-Margins-Client": CLIENT_HEADER,
						...body !== void 0 ? { "Content-Type": "application/json" } : {}
					},
					body: body !== void 0 ? JSON.stringify(body) : void 0
				});
				log(`→ ${sent.status}`);
				return sent;
			});
		} catch (err) {
			if (err instanceof TimeoutError) {
				if ((method === "GET" || method === "DELETE") && attempt < 2) {
					log("Timeout — retrying once...");
					return doFetch(method, path, query, body, attempt + 1);
				}
			}
			throw err;
		}
		await throwForStatus(response, path);
		return parseBody(response);
	}
	/**
	* Send a raw binary request (for CAS blob uploads).
	* Unlike doFetch, this sends the body as-is with the given Content-Type
	* and never retries timeouts.
	*/
	async function doFetchRaw(method, path, data, contentType) {
		const url = buildUrl(path);
		const response = await sendWithOidcRemint(async () => {
			const bearer = await resolveRequestBearer();
			log(`${method} ${url} (${data.length} bytes, key: ${maskKey(bearer)})`);
			const sent = await fetchWithTimeout(url, {
				method,
				headers: {
					Authorization: `Bearer ${bearer}`,
					Accept: "application/json",
					"X-Margins-Client": CLIENT_HEADER,
					"Content-Type": contentType
				},
				body: new Uint8Array(data)
			});
			log(`→ ${sent.status}`);
			return sent;
		});
		await throwForStatus(response, path);
		return parseBody(response);
	}
	return {
		get: (path, query) => doFetch("GET", path, query),
		post: (path, body) => doFetch("POST", path, void 0, body),
		put: (path, body) => doFetch("PUT", path, void 0, body),
		patch: (path, body) => doFetch("PATCH", path, void 0, body),
		delete: (path) => doFetch("DELETE", path),
		putRaw: (path, data, contentType) => doFetchRaw("PUT", path, data, contentType)
	};
}

//#endregion
export { createApiClient as t };