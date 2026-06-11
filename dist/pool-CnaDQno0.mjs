#!/usr/bin/env node
//#region src/lib/pool.ts
/**
* Run an async function for each item with bounded concurrency.
* Returns results in the same order as items.
*/
async function poolMap(items, concurrency, fn) {
	const results = new Array(items.length);
	let nextIndex = 0;
	async function worker() {
		while (nextIndex < items.length) {
			const idx = nextIndex++;
			results[idx] = await fn(items[idx]);
		}
	}
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

//#endregion
export { poolMap as t };