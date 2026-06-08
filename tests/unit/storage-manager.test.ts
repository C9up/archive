import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDriver, StorageManager } from "../../src/index.js";

let root: string;
let driver: LocalDriver;
let storage: StorageManager;

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-mgr-"));
	driver = new LocalDriver(root, { signingSecret: "s3cr3t-s3cr3t-s3cr3t" });
	storage = new StorageManager(driver);
});

afterEach(async () => {
	await fsp.rm(root, { recursive: true, force: true });
});

describe("archive > LocalDriver > stream + copy/move/list", () => {
	it("putStream writes the stream contents to disk", async () => {
		const readable = Readable.from(["hello ", "world"]);
		await driver.putStream("greet.txt", readable);
		const buf = await driver.get("greet.txt");
		expect(buf?.toString()).toBe("hello world");
	});

	it("getStream returns a readable that yields the stored bytes", async () => {
		await driver.put("data.bin", "abcdefg");
		const stream = await driver.getStream("data.bin");
		const chunks: Buffer[] = [];
		for await (const chunk of stream as AsyncIterable<Buffer>)
			chunks.push(chunk);
		expect(Buffer.concat(chunks).toString()).toBe("abcdefg");
	});

	it("getStream throws ARCHIVE_NOT_FOUND for a missing file", async () => {
		await expect(driver.getStream("ghost.txt")).rejects.toMatchObject({
			code: "ARCHIVE_NOT_FOUND",
		});
	});

	it("copy duplicates the object and does NOT carry visibility over", async () => {
		await driver.put("src.txt", "x");
		await driver.setVisibility("src.txt", "private");
		await driver.copy("src.txt", "dest.txt");
		const meta = await driver.getMetadata("dest.txt");
		expect(meta.visibility).toBe("public"); // sidecar is intentionally NOT copied
	});

	it("copy throws ARCHIVE_NOT_FOUND when the source is missing", async () => {
		await expect(driver.copy("missing.txt", "dest.txt")).rejects.toMatchObject({
			code: "ARCHIVE_NOT_FOUND",
		});
	});

	it("copy creates the destination directory tree on demand", async () => {
		await driver.put("a.txt", "z");
		await driver.copy("a.txt", "deep/nested/path/b.txt");
		expect(await driver.exists("deep/nested/path/b.txt")).toBe(true);
	});

	it("move relocates the object and preserves visibility (sidecar follows)", async () => {
		await driver.put("orig.txt", "x");
		await driver.setVisibility("orig.txt", "private");
		await driver.move("orig.txt", "moved.txt");
		expect(await driver.exists("orig.txt")).toBe(false);
		const meta = await driver.getMetadata("moved.txt");
		expect(meta.visibility).toBe("private");
	});

	it("move throws ARCHIVE_NOT_FOUND when the source is missing", async () => {
		await expect(driver.move("ghost.txt", "dest.txt")).rejects.toMatchObject({
			code: "ARCHIVE_NOT_FOUND",
		});
	});

	it("move creates the destination directory tree on demand", async () => {
		await driver.put("a.txt", "z");
		await driver.move("a.txt", "deep/x/b.txt");
		expect(await driver.exists("deep/x/b.txt")).toBe(true);
		expect(await driver.exists("a.txt")).toBe(false);
	});

	it("list yields entries under a prefix and excludes sidecars", async () => {
		await driver.put("public/a.txt", "1");
		await driver.put("public/b.txt", "2");
		await driver.setVisibility("public/a.txt", "private"); // creates sidecar
		await driver.put("other/c.txt", "3");

		const found: string[] = [];
		for await (const entry of driver.list("public/")) {
			found.push(entry.path);
		}
		expect(found.sort()).toEqual(["public/a.txt", "public/b.txt"]);
	});

	it("list yields nothing for a prefix that matches no files", async () => {
		await driver.put("a.txt", "1");
		const found: string[] = [];
		for await (const entry of driver.list("nope/")) found.push(entry.path);
		expect(found).toEqual([]);
	});
});

describe("archive > LocalDriver > url() visibility-aware routing", () => {
	it("url() returns the signed URL for private files", async () => {
		await driver.put("x.txt", "1");
		await driver.setVisibility("x.txt", "private");
		const u = await driver.url("x.txt");
		expect(u).toMatch(/sig=/);
		expect(u).toMatch(/exp=/);
	});

	it("url() returns the public URL for public/default-visibility files", async () => {
		await driver.put("y.txt", "1");
		const u = await driver.url("y.txt");
		expect(u).toBe("/storage/y.txt");
		expect(u).not.toMatch(/sig=/);
	});

	it("setVisibility on a missing file throws ARCHIVE_NOT_FOUND", async () => {
		await expect(
			driver.setVisibility("ghost.txt", "private"),
		).rejects.toMatchObject({
			code: "ARCHIVE_NOT_FOUND",
		});
	});

	it("readVisibility THROWS ARCHIVE_VISIBILITY_CORRUPT on malformed JSON (no silent private→public downgrade)", async () => {
		await driver.put("z.txt", "1");
		await driver.setVisibility("z.txt", "private");
		// Corrupt the sidecar to simulate disk damage / partial write.
		await fsp.writeFile(
			path.join(root, "z.txt.archive-visibility.json"),
			"{not-json",
		);
		await expect(driver.getMetadata("z.txt")).rejects.toMatchObject({
			code: "ARCHIVE_VISIBILITY_CORRUPT",
		});
		// `url()` is the security-critical call site — must also refuse to
		// serve rather than silently emit a public URL for the file.
		await expect(driver.url("z.txt")).rejects.toMatchObject({
			code: "ARCHIVE_VISIBILITY_CORRUPT",
		});
	});

	it("readVisibility still returns 'public' when the sidecar is simply absent (documented default)", async () => {
		await driver.put("nosidecar.txt", "1");
		const meta = await driver.getMetadata("nosidecar.txt");
		expect(meta.visibility).toBe("public");
	});
});

describe("archive > StorageManager > façade delegation", () => {
	it("forwards every method to the underlying driver", async () => {
		await storage.put("a.txt", "hello");
		expect(await storage.exists("a.txt")).toBe(true);

		const buf = await storage.get("a.txt");
		expect(buf?.toString()).toBe("hello");

		expect(storage.publicUrl("a.txt")).toBe("/storage/a.txt");

		const meta = await storage.getMetadata("a.txt");
		expect(meta.size).toBe(5);

		await storage.setVisibility("a.txt", "private");
		const url = await storage.url("a.txt");
		expect(url).toMatch(/sig=/);

		const signed = await storage.getSignedUrl("a.txt");
		expect(signed).toMatch(/sig=/);

		await storage.copy("a.txt", "b.txt");
		expect(await storage.exists("b.txt")).toBe(true);

		await storage.move("b.txt", "c.txt");
		expect(await storage.exists("b.txt")).toBe(false);
		expect(await storage.exists("c.txt")).toBe(true);

		const items: string[] = [];
		for await (const entry of storage.list("")) items.push(entry.path);
		expect(items.length).toBeGreaterThan(0);

		expect(await storage.delete("a.txt")).toBe(true);
		expect(await storage.delete("a.txt")).toBe(false);
	});

	it("putStream + getStream delegate to the driver", async () => {
		await storage.putStream("s.txt", Readable.from(["abc"]));
		const stream = await storage.getStream("s.txt");
		const chunks: Buffer[] = [];
		for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
		expect(Buffer.concat(chunks).toString()).toBe("abc");
	});
});

describe("archive > LocalDriver > signing-secret validation", () => {
	it("rejects a too-short signingSecret with ARCHIVE_WEAK_SIGNING_SECRET", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "weak-sec-"));
		try {
			expect(() => new LocalDriver(dir, { signingSecret: "short" })).toThrow(
				/at least 16/,
			);
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a non-string signingSecret", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "weak-sec-"));
		try {
			expect(
				() =>
					new LocalDriver(dir, {
						signingSecret: 12345 as unknown as string,
					}),
			).toThrow(/at least 16/);
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	it("creates the storage root if it does not exist", async () => {
		const dir = path.join(os.tmpdir(), `mkroot-${Date.now()}-${Math.random()}`);
		try {
			expect(() => new LocalDriver(dir)).not.toThrow();
			const stat = await fsp.stat(dir);
			expect(stat.isDirectory()).toBe(true);
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("archive > LocalDriver > security guards", () => {
	it("rejects filenames containing NUL / LF / CR control characters", async () => {
		await expect(driver.put("bad\nname.txt", "x")).rejects.toThrow(
			/control characters/,
		);
		await expect(driver.put("bad\rname.txt", "x")).rejects.toThrow(
			/control characters/,
		);
		await expect(driver.put("bad\0name.txt", "x")).rejects.toThrow(
			/control characters/,
		);
	});

	it("rejects path traversal via leading '..'", async () => {
		await expect(driver.put("../escape.txt", "x")).rejects.toThrow(
			/Path traversal/,
		);
	});

	it("exists() returns false for sidecar file paths regardless of state", async () => {
		await driver.put("y.txt", "1");
		await driver.setVisibility("y.txt", "private");
		expect(await driver.exists("y.txt.archive-visibility.json")).toBe(false);
	});
});
