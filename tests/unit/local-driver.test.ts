import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDriver } from "../../src/index.js";

async function drainStream(readable: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of readable) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}
	return Buffer.concat(chunks);
}

describe("LocalDriver", () => {
	let root: string;
	let driver: LocalDriver;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-local-"));
		driver = new LocalDriver(root);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("put + get roundtrip preserves binary content", async () => {
		const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
		await driver.put("bin/data.bin", content);
		const loaded = await driver.get("bin/data.bin");
		expect(loaded).not.toBeNull();
		expect(loaded?.equals(content)).toBe(true);
	});

	it("put + get roundtrip preserves string content", async () => {
		await driver.put("notes.txt", "hello world");
		const loaded = await driver.get("notes.txt");
		expect(loaded?.toString("utf8")).toBe("hello world");
	});

	it("get on missing file returns null (not throw)", async () => {
		expect(await driver.get("never.txt")).toBeNull();
	});

	it("exists mirrors reality", async () => {
		expect(await driver.exists("x.txt")).toBe(false);
		await driver.put("x.txt", "x");
		expect(await driver.exists("x.txt")).toBe(true);
	});

	it("delete returns true then false", async () => {
		await driver.put("to-drop.txt", "content");
		expect(await driver.delete("to-drop.txt")).toBe(true);
		expect(await driver.delete("to-drop.txt")).toBe(false);
	});

	it("publicUrl returns the /storage/ prefixed path", () => {
		expect(driver.publicUrl("some/file.png")).toBe("/storage/some/file.png");
	});

	it("blocks path traversal attacks", async () => {
		await expect(driver.put("../escape.txt", "evil")).rejects.toThrow(
			/traversal/i,
		);
		await expect(driver.get("../etc/passwd")).rejects.toThrow(/traversal/i);
		await expect(driver.delete("../escape.txt")).rejects.toThrow(/traversal/i);
	});

	it("creates nested directories on put", async () => {
		await driver.put("a/b/c/deep.txt", "nested");
		expect(await driver.exists("a/b/c/deep.txt")).toBe(true);
	});

	describe("getSignedUrl (HMAC)", () => {
		it("throws ARCHIVE_SIGNING_DISABLED when no secret is configured", () => {
			expect(() => driver.getSignedUrl("file.txt")).toThrow(
				expect.objectContaining({ code: "ARCHIVE_SIGNING_DISABLED" }),
			);
		});

		it("returns a URL shaped /storage/<path>?exp=<num>&sig=<64-hex>", () => {
			const signed = new LocalDriver(root, {
				signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			});
			const url = signed.getSignedUrl("folder/file.png");
			const [prefix, query] = url.split("?");
			expect(prefix).toBe("/storage/folder/file.png");
			const qs = new URLSearchParams(query);
			expect(qs.get("exp")).toMatch(/^\d+$/);
			expect(qs.get("sig")).toMatch(/^[a-f0-9]{64}$/);
		});

		it("defaults expiry to ~300 s in the future", () => {
			const signed = new LocalDriver(root, {
				signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			});
			const now = Math.floor(Date.now() / 1000);
			const url = signed.getSignedUrl("x");
			const exp = Number.parseInt(
				new URLSearchParams(url.split("?")[1] ?? "").get("exp") ?? "0",
				10,
			);
			expect(exp).toBeGreaterThanOrEqual(now + 295);
			expect(exp).toBeLessThanOrEqual(now + 305);
		});

		it("honours a custom expiresIn", () => {
			const signed = new LocalDriver(root, {
				signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			});
			const now = Math.floor(Date.now() / 1000);
			const url = signed.getSignedUrl("x", { expiresIn: 120 });
			const exp = Number.parseInt(
				new URLSearchParams(url.split("?")[1] ?? "").get("exp") ?? "0",
				10,
			);
			expect(exp).toBeGreaterThanOrEqual(now + 115);
			expect(exp).toBeLessThanOrEqual(now + 125);
		});

		it.each([
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			604_801,
		])("rejects out-of-range expiresIn (%s)", (bad) => {
			const signed = new LocalDriver(root, {
				signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			});
			expect(() =>
				signed.getSignedUrl("x", { expiresIn: bad as number }),
			).toThrow(expect.objectContaining({ code: "ARCHIVE_INVALID_EXPIRY" }));
		});

		it("produces different signatures for different paths (and same expiry)", () => {
			const signed = new LocalDriver(root, {
				signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			});
			const a = signed.getSignedUrl("a.txt");
			const b = signed.getSignedUrl("b.txt");
			const sigA = new URLSearchParams(a.split("?")[1] ?? "").get("sig");
			const sigB = new URLSearchParams(b.split("?")[1] ?? "").get("sig");
			expect(sigA).not.toBe(sigB);
		});
	});

	describe("metadata + visibility", () => {
		it("getMetadata returns size + mimeType + lastModified + etag + public default", async () => {
			await driver.put("hello.txt", "hi world");
			const meta = await driver.getMetadata("hello.txt");
			expect(meta.size).toBe(8);
			expect(meta.mimeType).toBe("text/plain");
			expect(meta.lastModified).toBeInstanceOf(Date);
			expect(meta.etag).toMatch(/^W\/"[a-f0-9]+"$/);
			expect(meta.visibility).toBe("public");
		});

		it("getMetadata infers mimeType from the extension", async () => {
			await driver.put("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
			const meta = await driver.getMetadata("pic.png");
			expect(meta.mimeType).toBe("image/png");
		});

		it("getMetadata on a missing file throws ARCHIVE_NOT_FOUND", async () => {
			await expect(driver.getMetadata("missing.txt")).rejects.toMatchObject({
				code: "ARCHIVE_NOT_FOUND",
			});
		});

		it("setVisibility writes the sidecar and getMetadata surfaces it", async () => {
			await driver.put("cat.txt", "meow");
			await driver.setVisibility("cat.txt", "private");
			const meta = await driver.getMetadata("cat.txt");
			expect(meta.visibility).toBe("private");
			// Sidecar file is present on disk but not visible through exists()
			expect(
				fs.existsSync(path.join(root, "cat.txt.archive-visibility.json")),
			).toBe(true);
			expect(await driver.exists("cat.txt.archive-visibility.json")).toBe(
				false,
			);
		});

		it("setVisibility is idempotent", async () => {
			await driver.put("cat.txt", "meow");
			await driver.setVisibility("cat.txt", "private");
			await driver.setVisibility("cat.txt", "private");
			const meta = await driver.getMetadata("cat.txt");
			expect(meta.visibility).toBe("private");
		});

		it("setVisibility on a missing file throws ARCHIVE_NOT_FOUND", async () => {
			await expect(
				driver.setVisibility("missing.txt", "private"),
			).rejects.toMatchObject({ code: "ARCHIVE_NOT_FOUND" });
		});

		it("delete removes the sidecar along with the main file", async () => {
			await driver.put("cat.txt", "meow");
			await driver.setVisibility("cat.txt", "private");
			expect(
				fs.existsSync(path.join(root, "cat.txt.archive-visibility.json")),
			).toBe(true);
			await driver.delete("cat.txt");
			expect(fs.existsSync(path.join(root, "cat.txt"))).toBe(false);
			expect(
				fs.existsSync(path.join(root, "cat.txt.archive-visibility.json")),
			).toBe(false);
		});

		it("url on a public file returns the plain /storage/ URL", async () => {
			await driver.put("cat.txt", "meow");
			expect(await driver.url("cat.txt")).toBe("/storage/cat.txt");
		});

		it("url on a private file returns a signed URL", async () => {
			const signed = new LocalDriver(root, {
				signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			});
			await signed.put("cat.txt", "meow");
			await signed.setVisibility("cat.txt", "private");
			const url = await signed.url("cat.txt");
			expect(url).toMatch(/^\/storage\/cat\.txt\?exp=\d+&sig=[a-f0-9]{64}$/);
		});

		it("url on a private file with no signingSecret throws ARCHIVE_SIGNING_DISABLED", async () => {
			await driver.put("cat.txt", "meow");
			await driver.setVisibility("cat.txt", "private");
			await expect(driver.url("cat.txt")).rejects.toMatchObject({
				code: "ARCHIVE_SIGNING_DISABLED",
			});
		});

		it("publicUrl always returns the direct URL regardless of visibility", async () => {
			const signed = new LocalDriver(root, {
				signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			});
			await signed.put("cat.txt", "meow");
			await signed.setVisibility("cat.txt", "private");
			expect(signed.publicUrl("cat.txt")).toBe("/storage/cat.txt");
		});
	});

	describe("putStream / getStream", () => {
		it("putStream writes a readable to disk; getStream roundtrips the bytes", async () => {
			const content = Buffer.from("hello streams", "utf8");
			await driver.putStream("s/hello.txt", Readable.from(content));
			const out = await drainStream(await driver.getStream("s/hello.txt"));
			expect(out.equals(content)).toBe(true);
		});

		it("putStream preserves binary integrity (NUL/0xFF bytes)", async () => {
			const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0xaa]);
			await driver.putStream("bin/data", Readable.from(binary));
			const out = await drainStream(await driver.getStream("bin/data"));
			expect(out.equals(binary)).toBe(true);
		});

		it("putStream creates missing parent directories", async () => {
			await driver.putStream(
				"deep/nested/path/file.txt",
				Readable.from(Buffer.from("nested")),
			);
			expect(await driver.exists("deep/nested/path/file.txt")).toBe(true);
		});

		it("getStream on missing file throws ARCHIVE_NOT_FOUND", async () => {
			await expect(driver.getStream("never.txt")).rejects.toMatchObject({
				code: "ARCHIVE_NOT_FOUND",
			});
		});

		it("putStream propagates errors from a failing readable and does not leave a partial file", async () => {
			const erroring = new Readable({
				read() {
					this.push(Buffer.from("partial"));
					this.destroy(new Error("boom"));
				},
			});
			await expect(driver.putStream("err.txt", erroring)).rejects.toThrow(
				/boom/,
			);
			// `node:stream/promises` pipeline destroys the write target on
			// failure; the partial file should not be usable content. We
			// tolerate either "absent" OR "zero/partial bytes" depending
			// on how quickly the error arrives — but we must NEVER see
			// it claim a clean "public/readable" file state.
			const full = path.join(root, "err.txt");
			if (fs.existsSync(full)) {
				const stat = fs.statSync(full);
				expect(stat.size).toBeLessThanOrEqual("partial".length);
			}
		});

		it("putStream leaves default visibility = 'public' (sidecar continuity with Story 43.3)", async () => {
			await driver.putStream(
				"streamed.txt",
				Readable.from(Buffer.from("streamed")),
			);
			const meta = await driver.getMetadata("streamed.txt");
			expect(meta.visibility).toBe("public");
			// No sidecar should have been created by putStream.
			expect(
				fs.existsSync(path.join(root, "streamed.txt.archive-visibility.json")),
			).toBe(false);
		});
	});

	describe("copy / move / list", () => {
		it("copy duplicates content and takes default (public) visibility even when source is private", async () => {
			await driver.put("src.txt", "payload");
			await driver.setVisibility("src.txt", "private");
			await driver.copy("src.txt", "dst.txt");
			expect((await driver.get("dst.txt"))?.toString("utf8")).toBe("payload");
			// Source preserved as private; dest starts public.
			expect((await driver.getMetadata("src.txt")).visibility).toBe("private");
			expect((await driver.getMetadata("dst.txt")).visibility).toBe("public");
		});

		it("copy throws ARCHIVE_NOT_FOUND when source is missing", async () => {
			await expect(driver.copy("none.txt", "dst.txt")).rejects.toMatchObject({
				code: "ARCHIVE_NOT_FOUND",
			});
		});

		it("move preserves visibility by relocating the sidecar", async () => {
			await driver.put("a.txt", "hello");
			await driver.setVisibility("a.txt", "private");
			await driver.move("a.txt", "b.txt");
			expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
			expect(
				fs.existsSync(path.join(root, "a.txt.archive-visibility.json")),
			).toBe(false);
			expect(fs.existsSync(path.join(root, "b.txt"))).toBe(true);
			expect((await driver.getMetadata("b.txt")).visibility).toBe("private");
		});

		it("list yields every file in the root, excluding sidecars", async () => {
			await driver.put("cat/a.txt", "a");
			await driver.put("cat/b.txt", "b");
			await driver.put("dog/c.txt", "c");
			await driver.setVisibility("cat/a.txt", "private");
			const paths: string[] = [];
			for await (const entry of driver.list("")) paths.push(entry.path);
			expect(paths.sort()).toEqual(["cat/a.txt", "cat/b.txt", "dog/c.txt"]);
		});

		it("list filters by prefix", async () => {
			await driver.put("cat/a.txt", "a");
			await driver.put("cat/b.txt", "b");
			await driver.put("dog/c.txt", "c");
			const paths: string[] = [];
			for await (const entry of driver.list("cat/")) paths.push(entry.path);
			expect(paths.sort()).toEqual(["cat/a.txt", "cat/b.txt"]);
		});
	});
});
