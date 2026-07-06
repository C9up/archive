/**
 * ArchiveProvider — registers a shared StorageManager in the host
 * framework's container. Apps add `@c9up/archive/provider` to their
 * `reamrc.ts` providers list and configure the driver under the
 * `archive` config key.
 *
 * Duck-typed against `ArchiveAppContext` so archive does NOT import
 * `@c9up/ream` — keeps the package publishable standalone.
 *
 * @example
 *   // reamrc.ts
 *   providers: [() => import('@c9up/archive/provider')]
 *
 *   // config/archive.ts
 *   export default {
 *     driver: 'local',
 *     local: { root: './storage' },
 *   }
 *
 *   // anywhere
 *   import storage from '@c9up/archive/services/main'
 *   await storage.put('uploads/avatar.png', buffer)
 */
import { type DriveConfig, DriveManager } from "./DriveManager.js";
import { ArchiveError } from "./errors.js";

import { type GcsConfig, GcsDriver } from "./GcsDriver.js";
import { type S3Config, S3Driver } from "./S3Driver.js";
import {
	LocalDriver,
	type StorageDriver,
	StorageManager,
} from "./StorageManager.js";
import { setStorage } from "./services/main.js";

interface ArchiveContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): T;
}
interface ArchiveConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface ArchiveAppContext {
	container: ArchiveContainer;
	config: ArchiveConfigStore;
}

/**
 * Legacy single-disk config shape (pre-parity). Still accepted: the
 * provider wraps it in a one-service DriveManager under the disk name
 * `default`. New apps should use the AdonisJS-parity {@link DriveConfig}
 * (`{ default, services, fakes }`) built with `defineConfig` + `services.*`.
 */
export interface ArchiveConfig {
	driver: "local" | "s3" | "gcs";
	local?: { root: string; signingSecret?: string };
	s3?: S3Config;
	gcs?: GcsConfig;
}

const DEFAULT_CONFIG: ArchiveConfig = {
	driver: "local",
	local: { root: "./storage" },
};

export default class ArchiveProvider {
	constructor(protected app: ArchiveAppContext) {}

	register(): void {
		this.app.container.singleton(DriveManager, () => {
			const raw = this.app.config.get<ArchiveConfig | DriveConfig>("archive");
			return new DriveManager(resolveDriveConfig(raw));
		});
		// Backward-compatible bindings — the default disk is what apps
		// previously resolved via `StorageManager` / the `storage` token.
		this.app.container.singleton(StorageManager, () =>
			this.app.container.resolve<DriveManager>(DriveManager).use(),
		);
		this.app.container.singleton("storage", () =>
			this.app.container.resolve<StorageManager>(StorageManager),
		);
		this.app.container.singleton("drive", () =>
			this.app.container.resolve<DriveManager>(DriveManager),
		);
	}

	async boot(): Promise<void> {
		// Skip eager resolution when archive is unconfigured: an app that
		// registers this provider but never uses storage should not trigger
		// LocalDriver's mkdirSync of './storage' at boot (breaks on
		// read-only rootfs). Explicit (object-shaped) configs still resolve.
		const archive = this.app.config.get<ArchiveConfig | DriveConfig>("archive");
		if (
			archive === undefined ||
			archive === null ||
			typeof archive !== "object"
		) {
			return;
		}
		const manager = this.app.container.resolve<StorageManager>(StorageManager);
		setStorage(manager);
	}

	async start(): Promise<void> {}
	async ready(): Promise<void> {}
	async shutdown(): Promise<void> {}
}

/** Narrow an unknown config value to the multi-disk {@link DriveConfig} shape. */
function isDriveConfig(config: unknown): config is DriveConfig {
	return (
		typeof config === "object" &&
		config !== null &&
		"services" in config &&
		typeof (config as { services: unknown }).services === "object" &&
		(config as { services: unknown }).services !== null
	);
}

/**
 * Reconcile whatever shape the app configured into a {@link DriveConfig}:
 *   - `{ default, services, fakes }` → used as-is (parity path).
 *   - legacy `{ driver, local, s3, gcs }` → wrapped as one `default` disk.
 *   - unset → the built-in local default.
 */
function resolveDriveConfig(
	raw: ArchiveConfig | DriveConfig | undefined,
): DriveConfig {
	if (isDriveConfig(raw)) return raw;
	const legacy: ArchiveConfig = raw ?? DEFAULT_CONFIG;
	return {
		default: "default",
		services: { default: () => buildDriver(legacy) },
	};
}

function buildDriver(config: ArchiveConfig): StorageDriver {
	if (config.driver === "s3") {
		if (!config.s3) {
			throw new ArchiveError(
				"ARCHIVE_CONFIG_MISSING",
				"Archive config.driver is 's3' but config.s3 is missing",
				{
					hint: "Provide { bucket, accessKeyId, secretAccessKey, region?, endpoint? } under config.archive.s3.",
				},
			);
		}
		return new S3Driver(config.s3);
	}
	if (config.driver === "gcs") {
		if (!config.gcs) {
			throw new ArchiveError(
				"ARCHIVE_CONFIG_MISSING",
				"Archive config.driver is 'gcs' but config.gcs is missing",
				{
					hint: "Provide { bucket, serviceAccount: { client_email, private_key } } under config.archive.gcs.",
				},
			);
		}
		return new GcsDriver(config.gcs);
	}
	if (config.driver === "local") {
		const root = config.local?.root ?? "./storage";
		return new LocalDriver(root, {
			signingSecret: config.local?.signingSecret,
		});
	}
	// Reject unknown driver values explicitly so a typo like
	// `{ driver: 'locla' }` does not silently fall through to the
	// local driver and write files to an unexpected location.
	throw new ArchiveError(
		"ARCHIVE_INVALID_DRIVER",
		`Archive config.driver must be 'local', 's3', or 'gcs', got '${String(config.driver)}'`,
		{ hint: "Set config.archive.driver to 'local', 's3', or 'gcs'." },
	);
}
