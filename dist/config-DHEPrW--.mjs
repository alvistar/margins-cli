#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import Conf from "conf";
import * as os from "node:os";

//#region src/lib/errors.ts
var MarginsError = class extends Error {
	constructor(message, userMessage, exitCode = 1) {
		super(message);
		this.userMessage = userMessage;
		this.exitCode = exitCode;
		this.name = this.constructor.name;
	}
};
var AuthMissing = class extends MarginsError {
	constructor() {
		super("No API key configured", "Not authenticated. Run: margins auth login", 1);
	}
};
var AuthExpired = class extends MarginsError {
	constructor() {
		super("API key expired or invalid", "API key expired or invalid. Run: margins auth login", 1);
	}
};
var NetworkError = class extends MarginsError {
	constructor(serverUrl) {
		super(`Network error reaching ${serverUrl}`, `Cannot reach ${serverUrl}. Check your connection.`, 1);
	}
};
var TimeoutError = class extends MarginsError {
	constructor() {
		super("Request timed out", "Request timed out. Try again.", 1);
	}
};
var ServerError = class extends MarginsError {
	constructor(status) {
		super(`Server error ${status}`, `Server error (${status}). Try again later.`, 1);
	}
};
var ForbiddenError = class extends MarginsError {
	constructor(resource = "this resource") {
		super(`Access denied to ${resource}`, `Access denied to ${resource}.`, 1);
	}
};
var NotFoundError = class extends MarginsError {
	constructor(resource) {
		super(`Not found: ${resource}`, `Not found: ${resource}.`, 1);
	}
};
var ResponseParseError = class extends MarginsError {
	constructor() {
		super("Unexpected server response", "Unexpected server response. Use --verbose for details.", 1);
	}
};
var ConfigParseError = class extends MarginsError {
	constructor(detail) {
		super(`Config parse error: ${detail}`, `${detail}. Delete and re-run: margins auth login`, 1);
	}
};
var ConflictError = class extends MarginsError {
	constructor(message) {
		super(`Conflict: ${message}`, message, 1);
	}
};
var WorkspaceNotFoundError = class extends MarginsError {
	constructor(slug) {
		super(`Workspace not found: ${slug}`, `Workspace '${slug}' not found.`, 1);
	}
};
var DiscussionNotFoundError = class extends MarginsError {
	constructor(id) {
		super(`Discussion not found: ${id}`, `Discussion '${id}' not found.`, 1);
	}
};
var ValidationError = class extends MarginsError {
	constructor(message) {
		super(`Validation error: ${message}`, message, 1);
	}
};
var LoginTimeout = class extends MarginsError {
	constructor() {
		super("Login timed out", "Login timed out (2 min). Try again.", 1);
	}
};
var OAuthError = class extends MarginsError {
	constructor(reason) {
		super(`OAuth error: ${reason}`, `Authentication failed: ${reason}`, 1);
	}
};

//#endregion
//#region src/lib/config.ts
let _store = null;
function getStore() {
	if (!_store) {
		let cwd = process.env["MARGINS_CONFIG_DIR"];
		if (!cwd) {
			const xdgBase = process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
			const xdgConfig = path.join(xdgBase, "margins", "config.json");
			if (fs.existsSync(xdgConfig)) cwd = path.dirname(xdgConfig);
		}
		_store = new Conf({
			projectName: "margins",
			projectSuffix: "",
			...cwd ? { cwd } : {}
		});
	}
	return _store;
}
function getGlobalConfig() {
	const store = getStore();
	return {
		apiKey: store.get("apiKey"),
		serverUrl: store.get("serverUrl"),
		accessToken: store.get("accessToken"),
		refreshToken: store.get("refreshToken"),
		accessTokenExpiresAt: store.get("accessTokenExpiresAt"),
		keycloakIssuer: store.get("keycloakIssuer"),
		keycloakClientId: store.get("keycloakClientId")
	};
}
function setGlobalConfig(updates) {
	const store = getStore();
	for (const key of [
		"apiKey",
		"serverUrl",
		"accessToken",
		"refreshToken",
		"accessTokenExpiresAt",
		"keycloakIssuer",
		"keycloakClientId"
	]) if (key in updates) {
		const val = updates[key];
		if (val == null) store.delete(key);
		else store.set(key, val);
	}
}
/**
* Walk up from cwd looking for .margins.json.
* Returns parsed contents, null if not found, throws ConfigParseError if malformed.
*/
function readLocalConfig() {
	let dir = process.cwd();
	const root = path.parse(dir).root;
	while (true) {
		const candidate = path.join(dir, ".margins.json");
		if (fs.existsSync(candidate)) {
			const raw = fs.readFileSync(candidate, "utf-8");
			try {
				return JSON.parse(raw);
			} catch (e) {
				throw new ConfigParseError(`Invalid .margins.json at ${candidate}: ${e.message}`);
			}
		}
		if (dir === root) break;
		dir = path.dirname(dir);
	}
	return null;
}
const DEFAULT_SERVER_URL = "https://margins.thealvistar.com";
/**
* Merge config sources in priority order:
*   1. CLI flags (--api-key, --server-url)
*   2. Env vars (MARGINS_API_KEY, MARGINS_SERVER_URL)
*   3. Local .margins.json (server_url only)
*   4. Global conf store
*/
function resolveConfig(cliOpts) {
	const global = getGlobalConfig();
	let local = null;
	try {
		local = readLocalConfig();
	} catch (err) {
		process.stderr.write(`Warning: ${err instanceof Error ? err.message : String(err)}\n`);
	}
	const apiKey = cliOpts.apiKey || process.env["MARGINS_API_KEY"] || global.apiKey || global.accessToken || void 0;
	const serverUrl = cliOpts.serverUrl || process.env["MARGINS_SERVER_URL"] || local?.server_url || global.serverUrl || DEFAULT_SERVER_URL;
	return {
		apiKey: apiKey || void 0,
		serverUrl,
		json: cliOpts.json ?? false,
		verbose: cliOpts.verbose ?? false,
		noColor: cliOpts.noColor ?? false,
		refreshToken: global.refreshToken,
		accessTokenExpiresAt: global.accessTokenExpiresAt,
		keycloakIssuer: global.keycloakIssuer,
		keycloakClientId: global.keycloakClientId
	};
}

//#endregion
export { TimeoutError as _, AuthExpired as a, DiscussionNotFoundError as c, MarginsError as d, NetworkError as f, ServerError as g, ResponseParseError as h, setGlobalConfig as i, ForbiddenError as l, OAuthError as m, readLocalConfig as n, AuthMissing as o, NotFoundError as p, resolveConfig as r, ConflictError as s, getGlobalConfig as t, LoginTimeout as u, ValidationError as v, WorkspaceNotFoundError as y };