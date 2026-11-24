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

import { E_ARCHIVE_UNKNOWN_DISK } from "./errors.js";
import type { GcsConfig } from "./GcsDriver.js";
import { GcsDriver } from "./GcsDriver.js";
import type { S3Config } from "./S3Driver.js";
import { S3Driver } from "./S3Driver.js";
import {
	LocalDriver,
	type ReleasableSecret,
	type StorageDriver,
	StorageManager,
	type Visibility,
} from "./StorageManager.js";
import { FakeStorageManager } from "./testing/FakeStorage.js";

/** A factory that constructs a fresh driver for a named disk. */
export type DriveServiceFactory = () => StorageDriver;

/**
 * Multi-disk configuration — AdonisJS Drive `defineConfig` shape:
 * `{ default, services }`.
 *
 * NAMED DEVIATION: no `fakes` key. Upstream's fake is a filesystem disk under
 * `fakes.location`, so it needs that config; ours is in memory (see
 * {@link DriveManager.fake}) and has nothing to configure.
 */
export interface DriveConfig {
	/** Name of the disk used when {@link DriveManager.use} is called with no argument. */
	default: string;
	/** Named disks, each a factory returning a driver (use the {@link services} helpers). */
	services: Record<string, DriveServiceFactory>;
}

/** Options accepted by {@link services.fs}. */
export interface FsServiceOptions {
	/** Storage root. `location` (Adonis name) and `root` are equivalent. */
	location?: string;
	/** Storage root (ream alias of `location`). */
	root?: string;
	/**
	 * HMAC secret enabling `getSignedUrl` on the LocalDriver: a string or a
	 * `Secret`, kept wrapped here and released by the driver.
	 */
	signingSecret?: string | ReleasableSecret;
	/**
	 * URL path the disk's files are served under (default `/storage`): the
	 * driver's URLs and the signed route both derive from it.
	 */
	routeBasePath?: string;
	/**
	 * The disk's visibility, required as upstream requires it: `'private'`
	 * makes every object private (the signed route serves nothing without a
	 * signature), `'public'` makes an object written without a visibility
	 * public. See the LocalDriver option of the same name.
	 */
	visibility: Visibility;
}

/**
 * Config helpers mirroring AdonisJS Drive's `services.fs/s3/gcs`. Each
 * returns a factory consumed by {@link DriveConfig.services}.
 *
 * NAMED DEVIATION: the ream `services.fs` builds URLs in-package via the
 * LocalDriver + signed-route handler — it does NOT couple to the router,
 * so there is no `serveFiles` that registers the route for you. Its
 * `routeBasePath` plays the upstream role all the same: the driver's URLs
 * and the signed route's prefix both derive from it.
 */
export const services: {
	fs(options: FsServiceOptions): DriveServiceFactory;
	s3(config: S3Config): DriveServiceFactory;
	gcs(config: GcsConfig): DriveServiceFactory;
} = {
	fs(options) {
		const root = options.location ?? options.root ?? "./storage";
		return () =>
			new LocalDriver(root, {
				signingSecret: options.signingSecret,
				routeBasePath: options.routeBasePath,
				visibility: options.visibility,
			});
	},
	s3(config) {
		return () => new S3Driver(config);
	},
	gcs(config) {
		return () => new GcsDriver(config);
	},
};

/**
 * The factory configured for a disk, or `undefined` when there is none. Only
 * OWN entries of `services` are disks: a plain lookup would answer
 * `constructor`, `toString` or `hasOwnProperty` with the function inherited
 * from `Object.prototype` and build a broken disk out of it.
 *
 * NAMED DEVIATION (stricter than flydrive's `DriveManager.use`, which reads
 * `services[name]` directly): an inherited name is an unknown disk.
 */
function serviceFactory(
	services: Record<string, DriveServiceFactory>,
	name: string,
): DriveServiceFactory | undefined {
	return Object.hasOwn(services, name) ? services[name] : undefined;
}

export class DriveManager {
	#config: DriveConfig;
	#cache = new Map<string, StorageManager>();
	#fakes = new Map<string, FakeStorageManager>();

	constructor(config: DriveConfig) {
		if (serviceFactory(config.services, config.default) === undefined) {
			throw Object.assign(
				new E_ARCHIVE_UNKNOWN_DISK([
					`Archive default disk '${config.default}' is not present in config.services`,
				]),
				{
					help: `Add a '${config.default}' entry to config.services, or point config.default at an existing disk.`,
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
		const factory = serviceFactory(this.#config.services, name);
		if (factory === undefined) {
			throw Object.assign(
				new E_ARCHIVE_UNKNOWN_DISK([
					`Archive disk '${name}' is not configured`,
				]),
				{
					help: `Known disks: ${Object.keys(this.#config.services).join(", ") || "(none)"}.`,
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
	 *
	 * NAMED DEVIATION: the fake keeps its files in memory, where flydrive's
	 * `FakeDisk` writes them under `fakes.location/<disk>` and refuses to fake
	 * without that config. Nothing reaches the filesystem, so parallel test
	 * files cannot collide on one directory and nothing is left to clean up
	 * after a crashed run.
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
