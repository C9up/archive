/**
 * Default `StorageManager` singleton — mirror of Adonis's
 * `import drive from '@adonisjs/drive/services/main'` shape.
 *
 *   import storage from '@c9up/archive/services/main'
 *
 *   await storage.put('uploads/avatar.png', buffer)
 *   const bytes = await storage.get('uploads/avatar.png')
 *
 * Populated by `ArchiveProvider.boot()`.
 */

import type { StorageManager } from "../StorageManager.js";

let instance: StorageManager | undefined;
let resolve: (() => StorageManager) | undefined;

/** @internal Bind the singleton (called by ArchiveProvider). */
export function setStorage(value: StorageManager): void {
	instance = value;
	resolve = undefined;
}

/**
 * @internal Bind a way to build the singleton on first genuine use.
 *
 * For the unconfigured case, where building it at boot would create
 * `./storage` for an application that may never touch storage — and fail
 * outright on a read-only rootfs. Skipping it entirely left the container
 * serving `storage` while this accessor threw "before boot": the same
 * application, two answers. Nothing is built until something reaches for it,
 * and then both paths give the same manager.
 */
export function setStorageResolver(factory: () => StorageManager): void {
	if (instance !== undefined) return;
	resolve = factory;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getStorage(): StorageManager | undefined {
	return instance;
}

const storage: StorageManager = new Proxy({} as StorageManager, {
	get(_target, prop) {
		// A module loader inspects what it imports before anyone uses it: it reads
		// `then` to decide whether the namespace is thenable, and various symbols
		// for interop and formatting. Throwing on those turns a plain
		// `import { setX } from ".../services/main"` into a crash at import time,
		// far from any real use. They are not members of what this stands in for,
		// so answer undefined and let a genuine access be the one that reports.
		if (typeof prop === "symbol" || prop === "then") {
			return undefined;
		}
		if (instance === undefined && resolve !== undefined) {
			instance = resolve();
			resolve = undefined;
		}
		if (!instance) {
			throw new Error(
				"[archive] StorageManager singleton accessed before ArchiveProvider.boot() ran. " +
					"Check that `@c9up/archive/provider` is listed in your reamrc.ts providers, " +
					"and that an `archive` config block is set.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default storage;
