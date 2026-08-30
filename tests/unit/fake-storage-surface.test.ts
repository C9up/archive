/**
 * The rest of the storage fake, and the disk manager on top of it.
 *
 * The fake is what a consuming app writes ITS upload tests against, so an
 * assertion here that cannot fail turns their green suite into a claim nobody
 * checked — and a `listAll` that reports the wrong shape sends them chasing a
 * bug in their own code.
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DriveManager, services } from "../../src/DriveManager.js";
import {
	FakeStorage,
	FakeStorageManager,
} from "../../src/testing/FakeStorage.js";

const filled = async () => {
	const fake = new FakeStorage();
	await fake.put("invoices/2026/a.pdf", Buffer.from("A"));
	await fake.put("invoices/2026/b.pdf", Buffer.from("B"));
	await fake.put("invoices/readme.txt", Buffer.from("read me"));
	await fake.put("other/c.txt", Buffer.from("C"));
	return fake;
};

describe("archive > the fake's read surface", () => {
	it("hands back bytes, and says so when there are none", async () => {
		const fake = new FakeStorage();
		await fake.put("a.txt", Buffer.from("hello"));

		expect(Buffer.from(await fake.getBytes("a.txt")).toString()).toBe("hello");
		await expect(fake.getBytes("missing.txt")).rejects.toMatchObject({
			code: "ARCHIVE_NOT_FOUND",
		});
	});

	it("reports visibility, and says so for an object that is not there", async () => {
		const fake = new FakeStorage();
		await fake.put("a.txt", Buffer.from("x"), { visibility: "public" });

		expect(await fake.getVisibility("a.txt")).toBe("public");
		await expect(fake.getVisibility("missing.txt")).rejects.toMatchObject({
			code: "ARCHIVE_NOT_FOUND",
		});
	});

	it("signs an upload URL that differs from the download one", async () => {
		const fake = new FakeStorage();

		const upload = fake.getSignedUploadUrl("a.txt");
		const download = fake.getSignedUrl("a.txt");

		// Handing a download URL to an uploader is a silent no-op at the far end.
		expect(upload).toContain("upload=1");
		expect(download).not.toContain("upload=1");
		expect(upload).toMatch(/exp=\d+/);
		expect(upload).toMatch(/sig=[0-9a-f]{64}/);
	});

	it("refuses an expiry outside the accepted range on an upload URL", () => {
		const fake = new FakeStorage();

		expect(() => fake.getSignedUploadUrl("a.txt", { expiresIn: -1 })).toThrow();
	});

	it("takes a stream in and gives one back", async () => {
		const fake = new FakeStorage();

		await fake.putStream("a.txt", Readable.from([Buffer.from("streamed")]));

		expect((await fake.get("a.txt"))?.toString()).toBe("streamed");
	});
});

describe("archive > the fake's bulk operations", () => {
	it("deletes everything under a prefix, and nothing beside it", async () => {
		const fake = await filled();

		await fake.deleteAll("invoices/");

		expect(await fake.exists("invoices/2026/a.pdf")).toBe(false);
		expect(await fake.exists("other/c.txt")).toBe(true);
	});

	it("lists the directories and the files at one level", async () => {
		const fake = await filled();

		const objects = [...(await fake.listAll("invoices")).objects];

		// A non-recursive listing groups the deeper keys into a directory
		// rather than flattening them into the file list.
		expect(objects.filter((o) => o.isDirectory).map((o) => o.name)).toEqual([
			"2026",
		]);
		expect(objects.filter((o) => o.isFile).map((o) => o.name)).toEqual([
			"readme.txt",
		]);
	});

	it("flattens everything when told to recurse", async () => {
		const fake = await filled();

		const objects = [
			...(await fake.listAll("invoices", { recursive: true })).objects,
		];

		expect(objects.every((o) => o.isFile)).toBe(true);
		expect(objects).toHaveLength(3);
	});

	it("reads the root from an empty prefix and from a bare slash", async () => {
		const fake = await filled();

		for (const prefix of ["", "/"]) {
			const names = [...(await fake.listAll(prefix)).objects].map(
				(o) => o.name,
			);
			expect(names, prefix).toContain("invoices");
			expect(names, prefix).toContain("other");
		}
	});

	it("takes a prefix written with or without its trailing slash", async () => {
		const fake = await filled();

		const withSlash = [...(await fake.listAll("invoices/")).objects];
		const without = [...(await fake.listAll("invoices")).objects];

		expect(without.map((o) => o.name)).toEqual(withSlash.map((o) => o.name));
	});

	it("carries the metadata onto each listed file", async () => {
		const fake = new FakeStorage();
		await fake.put("a.txt", Buffer.from("hello"), { visibility: "public" });

		const [file] = [...(await fake.listAll("")).objects];

		if (!file.isFile) throw new Error("expected a file");
		expect(await file.getMetaData()).toMatchObject({
			size: 5,
			visibility: "public",
		});
	});
});

describe("archive > the fake behind a manager", () => {
	it("forwards every assertion to the fake it wraps", async () => {
		const manager = new FakeStorageManager();
		await manager.put("a.txt", Buffer.from("hello"));

		expect(() => {
			manager.assertExists("a.txt");
			manager.assertExists(["a.txt"]);
			manager.assertMissing("b.txt");
			manager.assertStored("a.txt");
			manager.assertStored("a.txt", { contentContaining: "hello" });
			manager.assertNotStored("b.txt");
		}).not.toThrow();

		expect(() => manager.assertExists("b.txt")).toThrow();
		expect(() => manager.assertMissing("a.txt")).toThrow();
		expect(() => manager.assertStored("b.txt")).toThrow();
		expect(() => manager.assertNotStored("a.txt")).toThrow();
	});

	it("snapshots and wipes what it captured", async () => {
		const manager = new FakeStorageManager();
		await manager.put("a.txt", Buffer.from("hello"));

		expect(manager.getStored()).toHaveLength(1);
		manager.clear();
		expect(manager.getStored()).toHaveLength(0);
	});

	it("names the captured objects when an assertion fails", async () => {
		const manager = new FakeStorageManager();
		await manager.put("a.txt", Buffer.from("hello"));

		// Without the capture listing, a failure says nothing about what the
		// code under test actually wrote.
		expect(() => manager.assertStored("b.txt")).toThrow(/a\.txt/);
	});
});

describe("archive > choosing a disk", () => {
	const config = () => ({
		default: "local" as const,
		services: {
			local: services.fs({ location: "./storage" }),
			backup: services.fs({ location: "./backup" }),
		},
	});

	it("refuses a default that names no declared disk", () => {
		// Otherwise the failure lands on the first upload, in a request.
		expect(
			() =>
				new DriveManager({
					default: "missing",
					services: { local: services.fs() },
				}),
		).toThrow(/default disk 'missing' is not present/);
	});

	it("refuses a disk nobody declared, and lists the ones that exist", () => {
		try {
			new DriveManager(config()).use("typo");
			expect.unreachable("an undeclared disk has to be refused");
		} catch (error) {
			const archive = error as { message: string; hint?: string };
			expect(archive.message).toMatch(/'typo' is not configured/);
			// The list is what turns a typo into a one-second fix.
			expect(archive.hint).toContain("local, backup");
		}
	});

	it("resolves the declared default, and caches each disk", () => {
		const manager = new DriveManager(config());

		expect(manager.use()).toBe(manager.use("local"));
		expect(manager.use("local")).not.toBe(manager.use("backup"));
	});

	it("swaps a disk for a fake, and puts it back", async () => {
		const manager = new DriveManager(config());
		const real = manager.use();

		const fake = manager.fake();
		expect(manager.use()).toBe(fake);
		await manager.use().put("a.txt", Buffer.from("x"));
		fake.assertExists("a.txt");

		manager.restore();
		expect(manager.use()).toBe(real);
	});

	it("fakes one disk without touching the others", () => {
		const manager = new DriveManager(config());

		const fake = manager.fake("backup");

		expect(manager.use("backup")).toBe(fake);
		expect(manager.use("local")).not.toBe(fake);
	});

	it("clears the previous fake's state when faked twice", async () => {
		const manager = new DriveManager(config());
		const first = manager.fake();
		await manager.use().put("a.txt", Buffer.from("x"));

		const second = manager.fake();

		expect(second).not.toBe(first);
		// A fake carrying the previous test's uploads is a test that passes
		// because of the one before it.
		expect(second.getStored()).toHaveLength(0);
	});

	it("restoring a disk that was never faked does nothing", () => {
		const manager = new DriveManager(config());

		expect(() => manager.restore("backup")).not.toThrow();
	});
});

describe("archive > the config helpers", () => {
	it("hands the config straight back, in either shape", async () => {
		const { defineConfig } = await import("../../src/index.js");
		const multi = {
			default: "local" as const,
			services: { local: services.fs() },
		};
		const single = { driver: "local" as const, local: { root: "./storage" } };

		expect(defineConfig(multi)).toBe(multi);
		expect(defineConfig(single)).toBe(single);
	});

	it("builds a driver for each kind of disk", async () => {
		const { GcsDriver, LocalDriver, S3Driver } = await import(
			"../../src/index.js"
		);

		expect(services.fs()()).toBeInstanceOf(LocalDriver);
		expect(
			services.s3({
				bucket: "b",
				region: "us-east-1",
				accessKeyId: "k",
				secretAccessKey: "s",
			})(),
		).toBeInstanceOf(S3Driver);
		expect(
			services.gcs({
				bucket: "b",
				serviceAccount: { client_email: "a@b.test", private_key: "x" },
			})(),
		).toBeInstanceOf(GcsDriver);
	});

	it("takes `root` as an alias of `location`", async () => {
		const { LocalDriver } = await import("../../src/index.js");

		expect(services.fs({ root: "./elsewhere" })()).toBeInstanceOf(LocalDriver);
	});
});
