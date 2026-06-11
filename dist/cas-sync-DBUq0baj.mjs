#!/usr/bin/env node
import { g as ServerError, s as ConflictError, v as ValidationError } from "./config-DqP75CeC.mjs";
import { t as poolMap } from "./pool-CnaDQno0.mjs";
import { createHash } from "node:crypto";

//#region src/lib/cas-sync.ts
function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}
/**
* Compute a deterministic synthetic commit SHA from a path→hash manifest:
* sha256 over sorted entries of `path\thash\n` (sorted by path, plain byte
* order). Byte-identical to the desktop implementation
* (margins-desktop src-tauri/src/sync/cas_sync.rs `synthetic_commit_sha`) —
* the shared test vector lives in `__tests__/fixtures/synthetic-sha-vector.json`.
*
* Same input manifest → same SHA, so retries produce the same value and the
* server's headSha-match idempotency path (D-019) short-circuits cleanly.
* Output is a 64-char lowercase hex string satisfying ManifestPushSchema's
* `^[a-f0-9]{64}$` validation.
*/
function syntheticCommitSha(manifest) {
	const paths = Object.keys(manifest).sort((a, b) => Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8")));
	let buf = "";
	for (const path of paths) buf += `${path}\t${manifest[path]}\n`;
	return sha256(Buffer.from(buf, "utf-8"));
}
/** Count paths whose hash differs (or exists on only one side) between two manifests. */
function countManifestDiff(a, b) {
	let diff = 0;
	for (const [path, hash] of Object.entries(a)) if (b[path] !== hash) diff++;
	for (const path of Object.keys(b)) if (!(path in a)) diff++;
	return diff;
}
/** Map a 422 PUSH_SYNC_NOT_SUPPORTED server error to an actionable message. */
function mapSyncError(err) {
	if (err instanceof ServerError && err.code === "PUSH_SYNC_NOT_SUPPORTED") throw new ValidationError("This workspace does not support client push sync (its syncMode is not 'client'). Server-managed workspaces sync via GitHub — use `margins workspace sync` instead, or recreate the workspace with client sync enabled.");
	throw err;
}
const UPLOAD_CONCURRENCY = 5;
/**
* Content-addressable sync protocol.
*
* 1. Fetch the server manifest for the branch
* 2. Compute SHA-256 of each local file, diff against manifest
* 3. Upload new/changed blobs (up to 5 concurrent)
* 4. Commit the new manifest with a synthetic commitSha (derived from the
*    local manifest, see {@link syntheticCommitSha}) and parentSha = the
*    server's headSha from step 1. SHAs are computed here — callers never
*    supply them (git SHAs are the wrong shape AND the wrong semantics).
*
* On a 409 (headSha moved under us): refetch the manifest once, log loudly
* what we're replacing, and retry with the fresh headSha. A second 409 is a
* hard error. The retry is skipped if the process received SIGINT/SIGTERM
* (e.g. a cancelled CI run must not overwrite a newer run's tree).
*/
async function casSync(client, workspaceId, branch, files) {
	const basePath = `/api/workspaces/${workspaceId}/sync`;
	let interrupted = null;
	const makeHandler = (signal) => {
		const handler = () => {
			interrupted = signal;
			process.off(signal, handler);
			process.kill(process.pid, signal);
		};
		return handler;
	};
	const onSigint = makeHandler("SIGINT");
	const onSigterm = makeHandler("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	/** Abort instead of retrying once a termination signal has been received. */
	const throwIfInterrupted = () => {
		if (interrupted) throw new ConflictError(`Manifest push conflicted (409) but the process received ${interrupted} — aborting without retrying. Re-run the push to sync.`);
	};
	try {
		const manifest = await client.get(`${basePath}/manifest`, { branch }).catch(mapSyncError);
		const serverFiles = manifest.files ?? {};
		const localFiles = {};
		const localByHash = /* @__PURE__ */ new Map();
		for (const file of files) {
			const hash = sha256(file.content);
			localFiles[file.path] = hash;
			localByHash.set(hash, file);
		}
		let added = 0;
		let changed = 0;
		const deleted = Object.keys(serverFiles).filter((p) => !(p in localFiles)).length;
		const hashesOnServer = new Set(Object.values(serverFiles));
		const hashesToUpload = /* @__PURE__ */ new Set();
		for (const [filePath, hash] of Object.entries(localFiles)) {
			const serverHash = serverFiles[filePath];
			if (serverHash === void 0) {
				added++;
				if (!hashesOnServer.has(hash)) hashesToUpload.add(hash);
			} else if (serverHash !== hash) {
				changed++;
				if (!hashesOnServer.has(hash)) hashesToUpload.add(hash);
			}
		}
		const toUpload = [...hashesToUpload];
		await poolMap(toUpload, UPLOAD_CONCURRENCY, async (hash) => {
			const file = localByHash.get(hash);
			await client.putRaw(`${basePath}/objects/${hash}`, file.content, file.contentType);
		});
		const uploaded = toUpload.length;
		const commitSha = syntheticCommitSha(localFiles);
		const commitBody = (parentSha) => ({
			branch,
			commitSha,
			parentSha,
			files: localFiles
		});
		try {
			await client.post(`${basePath}/manifest`, commitBody(manifest.headSha));
		} catch (err) {
			if (!(err instanceof ConflictError)) mapSyncError(err);
			throwIfInterrupted();
			const fresh = await client.get(`${basePath}/manifest`, { branch }).catch(mapSyncError);
			const differing = countManifestDiff(localFiles, fresh.files ?? {});
			process.stderr.write(`[margins] Manifest conflict (409): another writer moved headSha to ${fresh.headSha ?? "(none)"}. Retrying once — this push will replace that manifest (${differing} file(s) differ vs the server manifest).\n`);
			throwIfInterrupted();
			try {
				await client.post(`${basePath}/manifest`, commitBody(fresh.headSha));
			} catch (retryErr) {
				if (retryErr instanceof ConflictError) throw new ConflictError("Manifest push conflicted twice (server headSha keeps moving). Another writer is actively pushing to this workspace — wait for it to finish and re-run the push.");
				mapSyncError(retryErr);
			}
		}
		return {
			added,
			changed,
			deleted,
			uploaded,
			skipped: files.length - added - changed
		};
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

//#endregion
export { casSync as t };