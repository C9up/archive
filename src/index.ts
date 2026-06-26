/**
 * @c9up/archive — File storage abstraction for the Ream framework.
 *
 * Drivers:
 *   - LocalDriver  (filesystem)
 *   - S3Driver     (S3 / R2 / MinIO via SigV4)
 *
 * Plus a StaticMiddleware for serving files over HTTP and a
 * signed-route handler for serving HMAC-signed Local URLs.
 */

export type { ArchiveConfig } from "./ArchiveProvider.js";
export { ArchiveError } from "./errors.js";
export {
	type GcsConfig,
	GcsDriver,
	type GcsServiceAccount,
} from "./GcsDriver.js";
export { type S3Config, S3Driver } from "./S3Driver.js";
export {
	type StaticConfig,
	StaticMiddleware,
	type StaticMiddlewareHttpContext,
	type StaticMiddlewareResponse,
} from "./StaticMiddleware.js";
export {
	LocalDriver,
	type LocalDriverOptions,
	type Metadata,
	type PutStreamOptions,
	type SignedUrlOptions,
	type StorageDriver,
	type StorageEntry,
	StorageManager,
	type Visibility,
} from "./StorageManager.js";
export {
	createSignedRouteHandler,
	type SignedRouteHttpContext,
	type SignedRouteOptions,
	type SignedRouteResponse,
} from "./signed-route.js";

import type { ArchiveConfig } from "./ArchiveProvider.js";

/**
 * Author-time config helper for `config/drive.ts` — AdonisJS Drive `defineConfig`
 * parity. Identity at runtime; the generic preserves literal types for inference.
 */
export function defineConfig<T extends ArchiveConfig>(config: T): T {
	return config;
}
