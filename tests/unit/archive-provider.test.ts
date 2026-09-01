import { describe, expect, it, vi } from "vitest";
import type { ArchiveAppContext } from "../../src/ArchiveProvider.js";
import ArchiveProvider from "../../src/ArchiveProvider.js";
import { services } from "../../src/DriveManager.js";
import { LocalDriver, S3Driver, StorageManager } from "../../src/index.js";

/**
 * Minimal container implementing the surface ArchiveProvider.register drives
 * (`singleton` + caching `resolve`). Mirrors the `ArchiveContainer` surface
 * the provider duck-types against — archive stays agnostic (no @c9up/ream
 * import), so this suite runs in isolation.
 */
class StubContainer {
	readonly #factories = new Map<unknown, () => unknown>();
	readonly #cache = new Map<unknown, unknown>();
	singleton(token: unknown, factory: () => unknown): void {
		this.#factories.set(token, factory);
	}
	async resolve<T = unknown>(token: unknown): Promise<T> {
		if (this.#cache.has(token)) return this.#cache.get(token) as T;
		const factory = this.#factories.get(token);
		if (!factory) throw new Error(`no binding for ${String(token)}`);
		const value = await factory();
		this.#cache.set(token, value);
		return value as T;
	}
}

/**
 * Build the agnostic `ArchiveAppContext` the provider consumes — the
 * StubContainer + an in-memory ConfigStore. The provider never imports
 * @c9up/ream, so this mirrors exactly the surface it duck-types against.
 */
function buildApp(initial: Record<string, unknown> = {}): ArchiveAppContext {
	const store = { ...initial };
	const config = {
		get<T = unknown>(key: string): T | undefined {
			return store[key] as T | undefined;
		},
		set(key: string, value: unknown): void {
			store[key] = value;
		},
	};
	return { container: new StubContainer(), config };
}

describe("ArchiveProvider", () => {
	it("binds StorageManager under both class and 'storage' string token", async () => {
		const app = buildApp({
			archive: { driver: "local", local: { root: "./tmp-storage" } },
		});
		new ArchiveProvider(app).register();

		const byClass = await app.container.resolve<StorageManager>(StorageManager);
		const byAlias = await app.container.resolve<StorageManager>("storage");
		expect(byClass).toBeInstanceOf(StorageManager);
		expect(byAlias).toBe(byClass);
	});

	// Audit 2026-06-13: signingSecret was unreachable through the provider/config,
	// so local signed URLs were dead via the framework path. This pins the wiring.
	it("wires config.archive.local.signingSecret so signed URLs work via the framework path", async () => {
		const app = buildApp({
			archive: {
				driver: "local",
				local: { root: "./tmp-storage-signed", signingSecret: "a".repeat(32) },
			},
		});
		new ArchiveProvider(app).register();
		const manager = await app.container.resolve<StorageManager>(StorageManager);
		// Pre-fix: signingSecret never reached the LocalDriver → E_ARCHIVE_SIGNING_DISABLED.
		const url = await manager.getSignedUrl("foo.txt");
		expect(typeof url).toBe("string");
		expect(url).toContain("foo.txt");
	});

	it("falls back to DEFAULT_CONFIG when app.config.get returns undefined", async () => {
		const app = buildApp({});
		new ArchiveProvider(app).register();
		await expect(
			app.container.resolve<StorageManager>(StorageManager),
		).resolves.toBeInstanceOf(StorageManager);
	});

	it("throws E_ARCHIVE_CONFIG_MISSING when driver is 's3' but config.s3 is absent", async () => {
		const app = buildApp({ archive: { driver: "s3" } });
		new ArchiveProvider(app).register();

		await expect(
			app.container.resolve<StorageManager>(StorageManager),
		).rejects.toThrow(
			expect.objectContaining({ code: "E_ARCHIVE_CONFIG_MISSING" }),
		);
	});

	it("throws E_ARCHIVE_INVALID_DRIVER on an unknown driver string", async () => {
		const app = buildApp({ archive: { driver: "locla" } });
		new ArchiveProvider(app).register();

		await expect(
			app.container.resolve<StorageManager>(StorageManager),
		).rejects.toThrow(
			expect.objectContaining({ code: "E_ARCHIVE_INVALID_DRIVER" }),
		);
	});

	it("builds an S3Driver-backed manager when driver is 's3' with valid s3 config", async () => {
		const app = buildApp({
			archive: {
				driver: "s3",
				s3: {
					bucket: "b",
					accessKeyId: "k",
					secretAccessKey: "s",
					region: "us-east-1",
				},
			},
		});
		new ArchiveProvider(app).register();

		const manager = await app.container.resolve<StorageManager>(StorageManager);
		expect(manager).toBeInstanceOf(StorageManager);
		// The manager wraps an S3Driver — check via publicUrl() shape.
		expect(manager.publicUrl("x/y.png")).toContain("/b/x/y.png");
	});

	it("builds a LocalDriver-backed manager when driver is 'local'", async () => {
		const app = buildApp({
			archive: { driver: "local", local: { root: "./tmp-archive" } },
		});
		new ArchiveProvider(app).register();

		const manager = await app.container.resolve<StorageManager>(StorageManager);
		expect(manager.publicUrl("file.png")).toBe("/storage/file.png");
		// Sanity: both driver classes are reachable from the barrel.
		expect(LocalDriver).toBeDefined();
		expect(S3Driver).toBeDefined();
	});

	it("boot() eagerly throws E_ARCHIVE_INVALID_DRIVER on a misspelled driver name", async () => {
		const app = buildApp({ archive: { driver: "locla" } });
		const provider = new ArchiveProvider(app);
		provider.register();

		await expect(provider.boot()).rejects.toThrow(
			expect.objectContaining({ code: "E_ARCHIVE_INVALID_DRIVER" }),
		);
	});

	it("boot() eagerly throws E_ARCHIVE_CONFIG_MISSING when driver-specific block is absent", async () => {
		const app = buildApp({ archive: { driver: "s3" } });
		const provider = new ArchiveProvider(app);
		provider.register();

		await expect(provider.boot()).rejects.toThrow(
			expect.objectContaining({ code: "E_ARCHIVE_CONFIG_MISSING" }),
		);
	});

	it("boot() is a no-op when archive is unconfigured (lazy DEFAULT_CONFIG path preserved)", async () => {
		const app = buildApp({});
		const provider = new ArchiveProvider(app);
		provider.register();

		await expect(provider.boot()).resolves.toBeUndefined();
		// Lazy resolution still falls back to DEFAULT_CONFIG when actually used.
		await expect(
			app.container.resolve<StorageManager>(StorageManager),
		).resolves.toBeInstanceOf(StorageManager);
	});

	it("boot() eagerly validates an explicit local config", async () => {
		const app = buildApp({
			archive: { driver: "local", local: { root: "./tmp-boot-archive" } },
		});
		const provider = new ArchiveProvider(app);
		provider.register();

		await expect(provider.boot()).resolves.toBeUndefined();
	});
});

describe("ArchiveProvider > the multi-disk bindings", () => {
	it("binds the disk manager under 'drive', and the default disk under 'storage'", async () => {
		const app = buildApp({
			archive: {
				default: "local",
				services: { local: services.fs({ location: "./tmp-multi" }) },
			},
		});
		const provider = new ArchiveProvider(app);
		provider.register();

		const drive = await app.container.resolve("drive");
		const storage = await app.container.resolve("storage");

		expect(drive).toBeDefined();
		// `storage` is the default disk of `drive`, not a second manager over
		// its own driver — two managers would mean two roots.
		expect(storage).toBe(await app.container.resolve(StorageManager));
	});

	it("resolves the same manager whichever token is asked for", async () => {
		const app = buildApp({
			archive: { driver: "local", local: { root: "./tmp-tokens" } },
		});
		const provider = new ArchiveProvider(app);
		provider.register();

		expect(await app.container.resolve("storage")).toBe(
			await app.container.resolve(StorageManager),
		);
	});

	it("has nothing to do on the remaining lifecycle hooks", async () => {
		const provider = new ArchiveProvider(buildApp({}));

		await expect(provider.start()).resolves.toBeUndefined();
		await expect(provider.ready()).resolves.toBeUndefined();
		await expect(provider.shutdown()).resolves.toBeUndefined();
	});
});

describe("ArchiveProvider > the two ways in agree", () => {
	it("serves the accessor from the same default the container uses", async () => {
		// A fresh module registry: the accessor holds a module-level singleton,
		// and an earlier test in this file has already populated it.
		vi.resetModules();
		const { default: ProviderFresh } = await import(
			"../../src/ArchiveProvider.js"
		);
		const { default: storage, getStorage } = await import(
			"../../src/services/main.js"
		);

		// No `archive` block. Booting returned early — nothing built, on purpose,
		// because building it creates ./storage and that fails on a read-only
		// rootfs. But the container still served `storage` from the default
		// config while the accessor threw "before boot": one application, two
		// answers.
		const provider = new ProviderFresh(buildApp({}));
		provider.register();
		await provider.boot();

		// Still nothing built — the reason for the early return survives.
		expect(getStorage()).toBeUndefined();

		// And a genuine access now works instead of throwing.
		expect(typeof storage.put).toBe("function");
		expect(getStorage()).toBeDefined();
	});

	it("leaves an explicit config resolving eagerly, as before", async () => {
		const app = buildApp({
			archive: { driver: "local", local: { root: "./tmp-storage-eager" } },
		});
		const provider = new ArchiveProvider(app);
		provider.register();
		await provider.boot();

		const { getStorage } = await import("../../src/services/main.js");
		expect(getStorage()).toBeDefined();
	});
});
