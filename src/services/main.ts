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

let _instance: StorageManager | undefined;

/** @internal Bind the singleton (called by ArchiveProvider). */
export function _setStorage(instance: StorageManager): void {
	_instance = instance;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function _getStorage(): StorageManager | undefined {
	return _instance;
}

const storage: StorageManager = new Proxy({} as StorageManager, {
	get(_target, prop) {
		if (!_instance) {
			throw new Error(
				"[archive] StorageManager singleton accessed before ArchiveProvider.boot() ran. " +
					"Check that `@c9up/archive/provider` is listed in your reamrc.ts providers, " +
					"and that an `archive` config block is set.",
			);
		}
		const value = Reflect.get(_instance, prop, _instance);
		return typeof value === "function" ? value.bind(_instance) : value;
	},
});

export default storage;
