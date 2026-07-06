/**
 * @c9up/archive — File storage abstraction for the Ream framework.
 *
 * Drivers:
 *   - LocalDriver  (filesystem)
 *   - S3Driver     (S3 / R2 / MinIO via SigV4)
 *   - GcsDriver    (Google Cloud Storage)
 *
 * A `DriveManager` provides AdonisJS Drive-style multi-disk resolution
 * (`use(name?)`), plus a `StaticMiddleware` for serving files over HTTP
 * and a signed-route handler for serving HMAC-signed Local URLs.
 */

export type { ArchiveConfig } from "./ArchiveProvider.js";
export {
	type DriveConfig,
	DriveManager,
	type DriveServiceFactory,
	type FsServiceOptions,
	services,
} from "./DriveManager.js";
export { ArchiveError } from "./errors.js";
export {
	type GcsConfig,
	GcsDriver,
	type GcsServiceAccount,
} from "./GcsDriver.js";
export { DriveDirectory, DriveFile } from "./objects.js";
export { type S3Config, S3Driver } from "./S3Driver.js";
export {
	type StaticConfig,
	StaticMiddleware,
	type StaticMiddlewareHttpContext,
	type StaticMiddlewareResponse,
} from "./StaticMiddleware.js";
export {
	type ListAllOptions,
	type ListAllResult,
	LocalDriver,
	type LocalDriverOptions,
	type Metadata,
	type PutStreamOptions,
	type SignedUrlOptions,
	type StorageDriver,
	type StorageEntry,
	StorageManager,
	type Visibility,
	type WriteOptions,
} from "./StorageManager.js";
export {
	createSignedRouteHandler,
	type SignedRouteHttpContext,
	type SignedRouteOptions,
	type SignedRouteResponse,
} from "./signed-route.js";

import type { ArchiveConfig } from "./ArchiveProvider.js";
import type { DriveConfig } from "./DriveManager.js";

/**
 * Author-time config helper for `config/archive.ts` — AdonisJS Drive
 * `defineConfig` parity. Identity at runtime; the generic preserves
 * literal types for inference.
 *
 * Accepts the multi-disk shape `{ default, services, fakes }` (build the
 * services with the `services.*` helpers) or the legacy single-disk
 * `{ driver, local, s3, gcs }` shape.
 */
export function defineConfig<T extends DriveConfig | ArchiveConfig>(
	config: T,
): T {
	return config;
}
