/**
 * ArchiveProvider — registers a shared StorageManager in the host
 * framework's container. Apps add `@c9up/archive/provider` to their
 * `reamrc.ts` providers list and configure the driver under the
 * `archive` config key.
 *
 * Duck-typed against `ArchiveAppContext` so archive does NOT import
 * `@c9up/ream` statically — keeps the package publishable standalone. At
 * boot it gives ream's uploads `moveToDisk(key, disk?, options?)` when ream
 * is installed (see `move-to-disk.ts`).
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
import "./augmentations.js";
import { type DriveConfig, DriveManager } from "./DriveManager.js";
import {
	E_ARCHIVE_CONFIG_MISSING,
	E_ARCHIVE_INVALID_DRIVER,
	E_ARCHIVE_PROVIDER_NOT_REGISTERED,
	E_ARCHIVE_TEMPLATE_ENGINE,
} from "./errors.js";

import { type GcsConfig, GcsDriver } from "./GcsDriver.js";
import { extendMultipartFile } from "./move-to-disk.js";
import { type S3Config, S3Driver } from "./S3Driver.js";
import {
	LocalDriver,
	type ReleasableSecret,
	type SignedUrlOptions,
	type StorageDriver,
	StorageManager,
} from "./StorageManager.js";
import {
	clearStorage,
	getStorage,
	setStorage,
	setStorageResolver,
} from "./services/main.js";

interface ArchiveContainer {
	singleton(token: unknown, factory: () => unknown): void;
	resolve<T = unknown>(token: unknown): Promise<T>;
}
interface ArchiveConfigStore {
	get<T = unknown>(key: string): T | undefined;
}
export interface ArchiveAppContext {
	container: ArchiveContainer;
	config: ArchiveConfigStore;
	/** Set by inker's provider when the app renders views with it. */
	usingInker?: boolean;
}

/**
 * Legacy single-disk config shape (pre-parity). Still accepted: the
 * provider wraps it in a one-service DriveManager under the disk name
 * `default`. New apps should use the AdonisJS-parity {@link DriveConfig}
 * (`{ default, services, fakes }`) built with `defineConfig` + `services.*`.
 */
export interface ArchiveConfig {
	driver: "local" | "s3" | "gcs";
	local?: {
		root: string;
		signingSecret?: string | ReleasableSecret;
		routeBasePath?: string;
	};
	s3?: S3Config;
	gcs?: GcsConfig;
}

const DEFAULT_CONFIG: ArchiveConfig = {
	driver: "local",
	local: { root: "./storage" },
};

export default class ArchiveProvider {
	/** What this provider bound, so shutdown only clears its own. */
	#owned: StorageManager | undefined;

	/**
	 * The one lazily-built manager, read by BOTH ways in. Set by
	 * {@link register}, which always runs before {@link boot}.
	 */
	#storage: (() => StorageManager) | undefined;

	/** The lazily-built disk manager behind it, likewise set by register(). */
	#drive: (() => DriveManager) | undefined;

	constructor(protected app: ArchiveAppContext) {}

	register(): void {
		// ONE cell, shared by the container's bindings and the service accessor.
		//
		// The container had its own factory and boot() built a second manager
		// for the accessor, so `services/main`'s storage and
		// `container.resolve(StorageManager)` were different objects over
		// different drivers: a fake bound in a test, or a driver swapped at
		// runtime, was invisible from the other side.
		//
		// Memoised here rather than resolved through the container because the
		// accessor is synchronous and the container is not — which is exactly
		// why boot() could not simply reuse the container's instance.
		let drive: DriveManager | undefined;
		const driveManager = (): DriveManager => {
			drive ??= new DriveManager(
				resolveDriveConfig(
					this.app.config.get<ArchiveConfig | DriveConfig>("archive"),
				),
			);
			return drive;
		};
		let manager: StorageManager | undefined;
		const storageManager = (): StorageManager => {
			manager ??= driveManager().use();
			return manager;
		};
		this.#storage = storageManager;
		this.#drive = driveManager;

		this.app.container.singleton(DriveManager, () => driveManager());
		// Backward-compatible bindings — the default disk is what apps
		// previously resolved via `StorageManager` / the `storage` token.
		this.app.container.singleton(StorageManager, () => storageManager());
		// Namespaced by the package that owns it, the way upstream namespaces
		// `lucid.db`, `auth.manager` and `drive.manager` by theirs. The bare
		// token stays bound beside it: it is what every existing
		// `container.make(...)` asks for, and a token is not worth breaking an
		// application over.
		this.app.container.singleton("archive.storage", () => storageManager());
		this.app.container.singleton("storage", () => storageManager());
		this.app.container.singleton("archive.drive", () => driveManager());
		this.app.container.singleton("drive", () => driveManager());
	}

	async boot(): Promise<void> {
		const storage = this.#storage;
		if (storage === undefined) {
			throw new E_ARCHIVE_PROVIDER_NOT_REGISTERED();
		}
		// The accessor reads the same cell the container's bindings read, so
		// however storage is reached there is one manager behind it.
		setStorageResolver(storage);
		await this.#registerViewHelpers();
		// Lazy like the helpers: the macro resolves the disk when an upload is
		// moved, so an unconfigured app builds nothing here.
		const drive = this.#drive;
		if (drive !== undefined) await extendMultipartFile(drive);

		// No eager construction when archive is unconfigured: an app that
		// registers this provider and never uses storage should not trigger
		// LocalDriver's mkdir of './storage' at boot, which fails on a
		// read-only rootfs. The resolver above is what keeps that lazy case
		// answering instead of throwing "before boot".
		const archive = this.app.config.get<ArchiveConfig | DriveConfig>("archive");
		if (
			archive === undefined ||
			archive === null ||
			typeof archive !== "object"
		) {
			return;
		}
		// Configured: build now, so a misspelled driver or a missing
		// driver-specific block is a boot failure rather than a surprise on the
		// first upload.
		const manager = storage();
		this.#owned = manager;
		setStorage(manager);
	}

	/**
	 * Publish `driveUrl` and `driveSignedUrl` to templates, as upstream's
	 * provider does for its view engine:
	 *
	 *   {{ await driveUrl(user.avatar) }}
	 *   {{ await driveSignedUrl(invoice.pdf, 'invoices', { expiresIn: '1h' }) }}
	 *
	 * Only when the app renders with inker (its provider sets `usingInker`),
	 * through inker's module singleton — the same way the i18n package
	 * publishes its globals, for the same reason: the engine's container
	 * binding is not resolvable during boot, while the singleton's `use()`
	 * queues the plugin until the first render. Nothing is built here: each
	 * helper resolves the disk when a template calls it.
	 */
	async #registerViewHelpers(): Promise<void> {
		const drive = this.#drive;
		if (this.app.usingInker !== true || drive === undefined) return;
		// Computed: inker is an optional peer, so a bundler must not try to
		// resolve it for an application that does not install it.
		const specifier = "@c9up/inker";
		const loaded: unknown = await import(/* @vite-ignore */ specifier);
		const engine =
			typeof loaded === "object" && loaded !== null
				? Reflect.get(loaded, "default")
				: undefined;
		const plugin = (target: unknown): void => {
			if (!publishesGlobals(target)) return;
			target.global("driveUrl", (key: string, disk?: string) =>
				drive().use(disk).getUrl(key),
			);
			target.global(
				"driveSignedUrl",
				(
					key: string,
					diskOrOptions?: string | SignedUrlOptions,
					options?: SignedUrlOptions,
				) =>
					typeof diskOrOptions === "string"
						? drive().use(diskOrOptions).getSignedUrl(key, options)
						: drive()
								.use()
								.getSignedUrl(key, diskOrOptions ?? options),
			);
		};
		if (isPluggable(engine)) engine.use(plugin);
		else if (publishesGlobals(engine)) plugin(engine);
		else {
			throw new E_ARCHIVE_TEMPLATE_ENGINE();
		}
	}

	async start(): Promise<void> {}
	async ready(): Promise<void> {}
	async shutdown(): Promise<void> {
		// Release the module-level singleton, while it is still ours. A stopped
		// application left a dead storage manager reachable through `services/main`, and
		// with two applications in one process the survivor's binding must not
		// be the one cleared.
		if (this.#owned !== undefined && getStorage() === this.#owned)
			clearStorage();
		this.#owned = undefined;
	}
}

/** An engine that queues plugins until it renders: inker's module singleton. */
function isPluggable(
	value: unknown,
): value is { use(plugin: (target: unknown) => void): unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		"use" in value &&
		typeof value.use === "function"
	);
}

/** An engine that publishes template globals. */
function publishesGlobals(
	value: unknown,
): value is { global(name: string, value: unknown): unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		"global" in value &&
		typeof value.global === "function"
	);
}

/** Narrow an unknown config value to the multi-disk {@link DriveConfig} shape. */
function isDriveConfig(config: unknown): config is DriveConfig {
	return (
		typeof config === "object" &&
		config !== null &&
		"services" in config &&
		typeof config.services === "object" &&
		config.services !== null
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
			throw Object.assign(
				new E_ARCHIVE_CONFIG_MISSING([
					"Archive config.driver is 's3' but config.s3 is missing",
				]),
				{
					help: "Provide { bucket, accessKeyId, secretAccessKey, region?, endpoint? } under config.archive.s3.",
				},
			);
		}
		return new S3Driver(config.s3);
	}
	if (config.driver === "gcs") {
		if (!config.gcs) {
			throw Object.assign(
				new E_ARCHIVE_CONFIG_MISSING([
					"Archive config.driver is 'gcs' but config.gcs is missing",
				]),
				{
					help: "Provide { bucket, serviceAccount: { client_email, private_key } } under config.archive.gcs.",
				},
			);
		}
		return new GcsDriver(config.gcs);
	}
	if (config.driver === "local") {
		const root = config.local?.root ?? "./storage";
		return new LocalDriver(root, {
			signingSecret: config.local?.signingSecret,
			routeBasePath: config.local?.routeBasePath,
		});
	}
	// Reject unknown driver values explicitly so a typo like
	// `{ driver: 'locla' }` does not silently fall through to the
	// local driver and write files to an unexpected location.
	throw new E_ARCHIVE_INVALID_DRIVER([String(config.driver)]);
}
