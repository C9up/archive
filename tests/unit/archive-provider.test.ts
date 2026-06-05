import type { AppContext, ConfigStore } from "@c9up/ream";
import { Container } from "@c9up/ream";
import { describe, expect, it } from "vitest";
import ArchiveProvider from "../../src/ArchiveProvider.js";
import { LocalDriver, S3Driver, StorageManager } from "../../src/index.js";

/**
 * Build a real `AppContext` using the real Ream `Container` + an
 * in-memory ConfigStore. No duck-typed mocks, no double-casts.
 */
function buildApp(initial: Record<string, unknown> = {}): AppContext {
	const store = { ...initial };
	const config: ConfigStore = {
		get<T>(key: string): T | undefined {
			return store[key] as T | undefined;
		},
		set(key: string, value: unknown): void {
			store[key] = value;
		},
	};
	return { container: new Container(), config };
}

describe("ArchiveProvider", () => {
	it("binds StorageManager under both class and 'storage' string token", () => {
		const app = buildApp({
			archive: { driver: "local", local: { root: "./tmp-storage" } },
		});
		new ArchiveProvider(app).register();

		const byClass = app.container.resolve<StorageManager>(StorageManager);
		const byAlias = app.container.resolve<StorageManager>("storage");
		expect(byClass).toBeInstanceOf(StorageManager);
		expect(byAlias).toBe(byClass);
	});

	it("falls back to DEFAULT_CONFIG when app.config.get returns undefined", () => {
		const app = buildApp({});
		new ArchiveProvider(app).register();
		expect(() =>
			app.container.resolve<StorageManager>(StorageManager),
		).not.toThrow();
	});

	it("throws ARCHIVE_CONFIG_MISSING when driver is 's3' but config.s3 is absent", () => {
		const app = buildApp({ archive: { driver: "s3" } });
		new ArchiveProvider(app).register();

		expect(() => app.container.resolve<StorageManager>(StorageManager)).toThrow(
			expect.objectContaining({ code: "ARCHIVE_CONFIG_MISSING" }),
		);
	});

	it("throws ARCHIVE_INVALID_DRIVER on an unknown driver string", () => {
		const app = buildApp({ archive: { driver: "locla" } });
		new ArchiveProvider(app).register();

		expect(() => app.container.resolve<StorageManager>(StorageManager)).toThrow(
			expect.objectContaining({ code: "ARCHIVE_INVALID_DRIVER" }),
		);
	});

	it("builds an S3Driver-backed manager when driver is 's3' with valid s3 config", () => {
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

		const manager = app.container.resolve<StorageManager>(StorageManager);
		expect(manager).toBeInstanceOf(StorageManager);
		// The manager wraps an S3Driver — check via publicUrl() shape.
		expect(manager.publicUrl("x/y.png")).toContain("/b/x/y.png");
	});

	it("builds a LocalDriver-backed manager when driver is 'local'", () => {
		const app = buildApp({
			archive: { driver: "local", local: { root: "./tmp-archive" } },
		});
		new ArchiveProvider(app).register();

		const manager = app.container.resolve<StorageManager>(StorageManager);
		expect(manager.publicUrl("file.png")).toBe("/storage/file.png");
		// Sanity: both driver classes are reachable from the barrel.
		expect(LocalDriver).toBeDefined();
		expect(S3Driver).toBeDefined();
	});

	it("boot() eagerly throws ARCHIVE_INVALID_DRIVER on a misspelled driver name", async () => {
		const app = buildApp({ archive: { driver: "locla" } });
		const provider = new ArchiveProvider(app);
		provider.register();

		await expect(provider.boot()).rejects.toThrow(
			expect.objectContaining({ code: "ARCHIVE_INVALID_DRIVER" }),
		);
	});

	it("boot() eagerly throws ARCHIVE_CONFIG_MISSING when driver-specific block is absent", async () => {
		const app = buildApp({ archive: { driver: "s3" } });
		const provider = new ArchiveProvider(app);
		provider.register();

		await expect(provider.boot()).rejects.toThrow(
			expect.objectContaining({ code: "ARCHIVE_CONFIG_MISSING" }),
		);
	});

	it("boot() is a no-op when archive is unconfigured (lazy DEFAULT_CONFIG path preserved)", async () => {
		const app = buildApp({});
		const provider = new ArchiveProvider(app);
		provider.register();

		await expect(provider.boot()).resolves.toBeUndefined();
		// Lazy resolution still falls back to DEFAULT_CONFIG when actually used.
		expect(() =>
			app.container.resolve<StorageManager>(StorageManager),
		).not.toThrow();
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
