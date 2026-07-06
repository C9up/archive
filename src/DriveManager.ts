/**
 * DriveManager — multi-disk registry (AdonisJS Drive / flydrive parity).
 *
 * Holds a set of named services (each a factory that returns a
 * {@link StorageDriver}), resolves them lazily into cached
 * {@link StorageManager} instances via {@link DriveManager.use}, and
 * offers a manager-level {@link DriveManager.fake}/{@link DriveManager.restore}
 * pair for tests.
 *
 *   const drive = new DriveManager({
 *     default: 'uploads',
 *     services: {
 *       uploads: services.fs({ location: './storage' }),
 *       s3: services.s3({ bucket, region, accessKeyId, secretAccessKey }),
 *     },
 *   })
 *   await drive.use().put('a.txt', 'hi')       // default disk
 *   await drive.use('s3').put('a.txt', 'hi')   // named disk
 */

import { ArchiveError } from "./errors.js";
import type { GcsConfig } from "./GcsDriver.js";
import { GcsDriver } from "./GcsDriver.js";
import type { S3Config } from "./S3Driver.js";
import { S3Driver } from "./S3Driver.js";
import {
	LocalDriver,
	type StorageDriver,
	StorageManager,
} from "./StorageManager.js";
import { FakeStorageManager } from "./testing/FakeStorage.js";

/** A factory that constructs a fresh driver for a named disk. */
export type DriveServiceFactory = () => StorageDriver;

/**
 * Multi-disk configuration — AdonisJS Drive `defineConfig` shape:
 * `{ default, services, fakes }`.
 */
export interface DriveConfig {
	/** Name of the disk used when {@link DriveManager.use} is called with no argument. */
	default: string;
	/** Named disks, each a factory returning a driver (use the {@link services} helpers). */
	services: Record<string, DriveServiceFactory>;
	/** Optional fakes configuration (reserved; the in-memory fake needs no location). */
	fakes?: { location?: string };
}

/** Options accepted by {@link services.fs}. */
export interface FsServiceOptions {
	/** Storage root. `location` (Adonis name) and `root` are equivalent. */
	location?: string;
	/** Storage root (ream alias of `location`). */
	root?: string;
	/** HMAC secret enabling `getSignedUrl` on the LocalDriver. */
	signingSecret?: string;
}

/**
 * Config helpers mirroring AdonisJS Drive's `services.fs/s3/gcs`. Each
 * returns a factory consumed by {@link DriveConfig.services}.
 *
 * DIVERGENCE (documented, deliberate): the ream `services.fs` builds URLs
 * in-package via the LocalDriver + signed-route handler — it does NOT
 * couple to the ream router the way Adonis wires `serveFiles`/`routeBasePath`.
 */
export const services: {
	fs(options?: FsServiceOptions): DriveServiceFactory;
	s3(config: S3Config): DriveServiceFactory;
	gcs(config: GcsConfig): DriveServiceFactory;
} = {
	fs(options) {
		const root = options?.location ?? options?.root ?? "./storage";
		return () =>
			new LocalDriver(root, { signingSecret: options?.signingSecret });
	},
	s3(config) {
		return () => new S3Driver(config);
	},
	gcs(config) {
		return () => new GcsDriver(config);
	},
};

export class DriveManager {
	#config: DriveConfig;
	#cache = new Map<string, StorageManager>();
	#fakes = new Map<string, FakeStorageManager>();

	constructor(config: DriveConfig) {
		if (config.services[config.default] === undefined) {
			throw new ArchiveError(
				"ARCHIVE_UNKNOWN_DISK",
				`Archive default disk '${config.default}' is not present in config.services`,
				{
					hint: `Add a '${config.default}' entry to config.services, or point config.default at an existing disk.`,
				},
			);
		}
		this.#config = config;
	}

	/**
	 * Resolve a disk by name (default when omitted). Returns the active
	 * fake for the disk when one has been installed via {@link fake}.
	 * Instances are cached and reused.
	 */
	use(service?: string): StorageManager {
		const name = service ?? this.#config.default;
		const fake = this.#fakes.get(name);
		if (fake) return fake;
		const cached = this.#cache.get(name);
		if (cached) return cached;
		const factory = this.#config.services[name];
		if (factory === undefined) {
			throw new ArchiveError(
				"ARCHIVE_UNKNOWN_DISK",
				`Archive disk '${name}' is not configured`,
				{
					hint: `Known disks: ${Object.keys(this.#config.services).join(", ") || "(none)"}.`,
				},
			);
		}
		const manager = new StorageManager(factory());
		this.#cache.set(name, manager);
		return manager;
	}

	/**
	 * Swap a disk for an in-memory {@link FakeStorageManager}. Subsequent
	 * {@link use} calls for the same disk return the fake until
	 * {@link restore} is called. AdonisJS Drive parity.
	 */
	fake(service?: string): FakeStorageManager {
		const name = service ?? this.#config.default;
		this.restore(name);
		const fake = new FakeStorageManager();
		this.#fakes.set(name, fake);
		return fake;
	}

	/** Remove the fake for a disk (default when omitted) and clear its state. */
	restore(service?: string): void {
		const name = service ?? this.#config.default;
		const fake = this.#fakes.get(name);
		if (fake) {
			fake.clear();
			this.#fakes.delete(name);
		}
	}
}
