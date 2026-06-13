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
		this.app.container.singleton(StorageManager, () => {
			const config =
				this.app.config.get<ArchiveConfig>("archive") ?? DEFAULT_CONFIG;
			const driver: StorageDriver = buildDriver(config);
			return new StorageManager(driver);
		});
		this.app.container.singleton("storage", () =>
			this.app.container.resolve<StorageManager>(StorageManager),
		);
	}

	async boot(): Promise<void> {
		// Skip eager validation when archive is unconfigured: an app that
		// registers this provider but never uses storage should not trigger
		// LocalDriver's mkdirSync of './storage' at boot (breaks on
		// read-only rootfs). Explicit (object-shaped) configs still fail
		// fast.
		const archive = this.app.config.get<ArchiveConfig>("archive");
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
