import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeStorage } from "../../src/testing/FakeStorage.js";

async function drainStream(readable: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of readable) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}
	return Buffer.concat(chunks);
}

describe("FakeStorage", () => {
	let storage: FakeStorage;

	beforeEach(() => {
		storage = new FakeStorage();
	});

	it("put + get roundtrips binary content", async () => {
		const content = Buffer.from([0x00, 0x01, 0xff]);
		await storage.put("bin", content);
		expect((await storage.get("bin"))?.equals(content)).toBe(true);
	});

	it("get returns null for missing object", async () => {
		expect(await storage.get("nope")).toBeNull();
	});

	it("delete returns true then false", async () => {
		await storage.put("x", "x");
		expect(await storage.delete("x")).toBe(true);
		expect(await storage.delete("x")).toBe(false);
	});

	it("exists reports truthfully", async () => {
		expect(await storage.exists("missing")).toBe(false);
		await storage.put("there", "there");
		expect(await storage.exists("there")).toBe(true);
	});

	it("putStream + getStream roundtrip", async () => {
		await storage.putStream(
			"streamed",
			Readable.from(Buffer.from("hello streams")),
		);
		const out = await drainStream(await storage.getStream("streamed"));
		expect(out.toString("utf8")).toBe("hello streams");
	});

	it("getStream on missing throws ARCHIVE_NOT_FOUND", async () => {
		await expect(storage.getStream("none")).rejects.toMatchObject({
			code: "ARCHIVE_NOT_FOUND",
		});
	});

	it("getMetadata surfaces size, mimeType, visibility, weak etag", async () => {
		await storage.put("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const meta = await storage.getMetadata("pic.png");
		expect(meta.size).toBe(4);
		expect(meta.mimeType).toBe("image/png");
		expect(meta.visibility).toBe("public");
		expect(meta.etag).toMatch(/^W\/"[a-f0-9]+"$/);
	});

	it("setVisibility flips visibility and survives getMetadata", async () => {
		await storage.put("cat.txt", "meow");
		await storage.setVisibility("cat.txt", "private");
		expect((await storage.getMetadata("cat.txt")).visibility).toBe("private");
	});

	it("setVisibility on missing throws ARCHIVE_NOT_FOUND", async () => {
		await expect(
			storage.setVisibility("none", "private"),
		).rejects.toMatchObject({ code: "ARCHIVE_NOT_FOUND" });
	});

	it("url branches on visibility", async () => {
		await storage.put("cat.txt", "meow");
		expect(await storage.url("cat.txt")).toBe("fake://cat.txt");
		await storage.setVisibility("cat.txt", "private");
		const privateUrl = await storage.url("cat.txt");
		expect(privateUrl).toMatch(/^fake:\/\/cat\.txt\?exp=\d+&sig=[a-f0-9]{64}$/);
	});

	it("publicUrl always returns the direct fake:// URL", () => {
		expect(storage.publicUrl("folder/cat.png")).toBe("fake://folder/cat.png");
	});

	it("getSignedUrl respects custom expiresIn and rejects out-of-range", () => {
		const url = storage.getSignedUrl("x", { expiresIn: 60 });
		const exp = Number.parseInt(
			new URLSearchParams(url.split("?")[1] ?? "").get("exp") ?? "0",
			10,
		);
		const now = Math.floor(Date.now() / 1000);
		expect(exp).toBeGreaterThanOrEqual(now + 55);
		expect(exp).toBeLessThanOrEqual(now + 65);
		expect(() => storage.getSignedUrl("x", { expiresIn: 0 })).toThrow(
			expect.objectContaining({ code: "ARCHIVE_INVALID_EXPIRY" }),
		);
	});

	it("copy duplicates content and takes default visibility", async () => {
		await storage.put("src.txt", "payload");
		await storage.setVisibility("src.txt", "private");
		await storage.copy("src.txt", "dst.txt");
		expect((await storage.get("dst.txt"))?.toString("utf8")).toBe("payload");
		// Source still private, but copy defaults to public.
		expect((await storage.getMetadata("src.txt")).visibility).toBe("private");
		expect((await storage.getMetadata("dst.txt")).visibility).toBe("public");
	});

	it("copy throws ARCHIVE_NOT_FOUND when source is missing", async () => {
		await expect(storage.copy("none", "dst")).rejects.toMatchObject({
			code: "ARCHIVE_NOT_FOUND",
		});
	});

	it("move preserves visibility and removes source", async () => {
		await storage.put("a.txt", "hello");
		await storage.setVisibility("a.txt", "private");
		await storage.move("a.txt", "b.txt");
		expect(await storage.exists("a.txt")).toBe(false);
		expect(await storage.exists("b.txt")).toBe(true);
		expect((await storage.getMetadata("b.txt")).visibility).toBe("private");
	});

	it("list yields entries matching the prefix", async () => {
		await storage.put("cat/a.txt", "a");
		await storage.put("cat/b.txt", "b");
		await storage.put("dog/c.txt", "c");
		const out: string[] = [];
		for await (const entry of storage.list("cat/")) out.push(entry.path);
		expect(out.sort()).toEqual(["cat/a.txt", "cat/b.txt"]);
	});

	it("two FakeStorage instances are isolated", async () => {
		const other = new FakeStorage();
		await storage.put("shared", "one");
		expect(await other.get("shared")).toBeNull();
	});

	it("clear() wipes state", async () => {
		await storage.put("a", "a");
		await storage.put("b", "b");
		storage.clear();
		expect(await storage.exists("a")).toBe(false);
		expect(await storage.exists("b")).toBe(false);
	});

	it("dump() returns a snapshot of current content", async () => {
		await storage.put("a", "hello");
		await storage.put("b", "world");
		const snap = storage.dump();
		expect(Object.keys(snap).sort()).toEqual(["a", "b"]);
		expect(snap.a?.toString("utf8")).toBe("hello");
		expect(snap.b?.toString("utf8")).toBe("world");
	});

	it("reset() is an alias for clear()", async () => {
		await storage.put("a", "a");
		storage.reset();
		expect(await storage.exists("a")).toBe(false);
	});

	it("getStored() returns a defensive snapshot with path/content/mime/visibility", async () => {
		await storage.put("docs/readme.txt", "hello");
		const stored = storage.getStored();
		expect(stored).toHaveLength(1);
		expect(stored[0].path).toBe("docs/readme.txt");
		expect(stored[0].content.toString("utf8")).toBe("hello");
		expect(stored[0].visibility).toBe("public");
		// Mutating the snapshot does not affect the store.
		stored[0].content.write("X", 0);
		const fresh = storage.getStored();
		expect(fresh[0].content.toString("utf8").startsWith("X")).toBe(false);
	});

	it("assertStored passes when the path was put()", async () => {
		await storage.put("a.txt", "alpha");
		expect(() => storage.assertStored("a.txt")).not.toThrow();
	});

	it("assertStored throws when the path was not put()", () => {
		expect(() => storage.assertStored("nope.txt")).toThrow(
			/no captured object matches/,
		);
	});

	it("assertStored with contentContaining narrows", async () => {
		await storage.put("a.txt", "hello world");
		expect(() =>
			storage.assertStored("a.txt", { contentContaining: "world" }),
		).not.toThrow();
		expect(() =>
			storage.assertStored("a.txt", { contentContaining: "missing" }),
		).toThrow(/no captured object matches/);
	});

	it("assertStored rejects empty contentContaining (would match every object)", async () => {
		await storage.put("a.txt", "any");
		expect(() =>
			storage.assertStored("a.txt", { contentContaining: "" }),
		).toThrow(/cannot be an empty string/);
	});

	it("assertStored with mimeType narrows", async () => {
		await storage.put("doc.txt", "plain text");
		expect(() =>
			storage.assertStored("doc.txt", { mimeType: "text/plain" }),
		).not.toThrow();
		expect(() =>
			storage.assertStored("doc.txt", { mimeType: "application/json" }),
		).toThrow(/no captured object matches/);
	});

	it("assertStored with function predicate gives full entry access", async () => {
		await storage.put("a.txt", "small");
		expect(() =>
			storage.assertStored("a.txt", (e) => e.content.length === 5),
		).not.toThrow();
		expect(() =>
			storage.assertStored("a.txt", (e) => e.content.length > 100),
		).toThrow(/no captured object matches/);
	});

	it("assertNotStored passes when the path was not put()", () => {
		expect(() => storage.assertNotStored("never.txt")).not.toThrow();
	});

	it("assertNotStored throws when the path was put()", async () => {
		await storage.put("a.txt", "x");
		expect(() => storage.assertNotStored("a.txt")).toThrow(
			/at least one captured object matches/,
		);
	});
});
