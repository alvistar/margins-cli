#!/usr/bin/env node
import { d as MarginsError } from "./config-DHEPrW--.mjs";

//#region src/lib/output.ts
function maskKey(key) {
	if (!key) return "(not set)";
	if (key.length < 10) return `${key.slice(0, 2)}...`;
	return `${key.slice(0, 5)}...${key.slice(-3)}`;
}
function formatJson(data) {
	return JSON.stringify(data, null, 2);
}
function formatError(err, json) {
	if (json) {
		const message = err instanceof MarginsError ? err.userMessage : err instanceof Error ? err.message : String(err);
		const code = err instanceof MarginsError ? err.constructor.name : "UnknownError";
		return JSON.stringify({
			error: message,
			code
		});
	}
	if (err instanceof MarginsError) return `Error: ${err.userMessage}`;
	if (err instanceof Error) return `Error: ${err.message}`;
	return `Error: ${String(err)}`;
}
function formatTable(headers, rows, emptyMessage) {
	if (rows.length === 0) return emptyMessage ?? "";
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
	return [
		headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join("│"),
		sep,
		...rows.map((r) => r.map((cell, i) => ` ${(cell ?? "").padEnd(widths[i])} `).join("│"))
	].join("\n");
}

//#endregion
export { maskKey as i, formatJson as n, formatTable as r, formatError as t };