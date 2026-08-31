/**
 * The local disk's bulk and metadata surface, and the facade over it.
 *
 * These are the paths a real deployment takes and the test suite never did:
 * listing a folder, emptying one, moving a file with its visibility, and the
 * pass-through methods a consumer calls on the manager rather than the driver.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDriver, StorageManager } from "../../src/index.js";

describe("archive > the local disk", () => {
	let root: string;
	let driver: LocalDriver;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-local-"));
		driver = new LocalDriver(root, { signingSecret: "s".repeat(32) });
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const seed = async () => {
		await driver.put("invoices/2026/a.pdf", Buffer.from("A"));
		await driver.put("invoices/2026/b.pdf", Buffer.from("B"));
		await driver.put("invoices/readme.txt", Buffer.from("read me"));
		await driver.put("other/c.txt", Buffer.from("C"));
	};

	describe("listing", () => {
		it("groups the deeper keys into a directory at one level", async () => {
			await seed();

			const objects = [...(await driver.listAll("invoices")).objects];

			expect(objects.filter((o) => o.isDirectory).map((o) => o.name)).toEqual([
				"2026",
			]);
			expect(objects.filter((o) => o.isFile).map((o) => o.name)).toEqual([
				"readme.txt",
			]);
		});

		it("flattens everything when told to recurse", async () => {
			await seed();

			const objects = [
				...(await driver.listAll("invoices", { recursive: true })).objects,
			];

			expect(objects.every((o) => o.isFile)).toBe(true);
			expect(objects).toHaveLength(3);
		});

		it("takes a prefix written with or without its trailing slash", async () => {
			await seed();

			const withSlash = [...(await driver.listAll("invoices/")).objects];
			const without = [...(await driver.listAll("invoices")).objects];

			expect(without.map((o) => o.name)).toEqual(withSlash.map((o) => o.name));
		});

		it("reads the root from an empty prefix and from a bare slash", async () => {
			await seed();

			for (const prefix of ["", "/"]) {
				const names = [...(await driver.listAll(prefix)).objects].map(
					(o) => o.name,
				);
				expect(names, prefix).toContain("invoices");
				expect(names, prefix).toContain("other");
			}
		});

		it("carries size, type and visibility onto each listed file", async () => {
			await driver.put("a.txt", Buffer.from("hello"));
			await driver.setVisibility("a.txt", "private");

			const [file] = [...(await driver.listAll("")).objects];

			if (!file.isFile) throw new Error("expected a file");
			expect(await file.getMetaData()).toMatchObject({
				size: 5,
				mimeType: "text/plain",
				visibility: "private",
			});
		});

		it("lists nothing for a root that does not exist yet", async () => {
			const empty = new LocalDriver(path.join(root, "not-created"));

			expect([...(await empty.listAll("")).objects]).toEqual([]);
		});
	});

	describe("emptying a prefix", () => {
		it("removes every file under it, and nothing beside it", async () => {
			await seed();

			await driver.deleteAll("invoices/");

			expect(await driver.exists("invoices/2026/a.pdf")).toBe(false);
			expect(await driver.exists("other/c.txt")).toBe(true);
		});

		it("takes the sidecars with it", async () => {
			await driver.put("invoices/a.pdf", Buffer.from("A"));
			await driver.setVisibility("invoices/a.pdf", "private");

			await driver.deleteAll("invoices/");

			// A stale sidecar left behind would give the NEXT file at that path
			// the previous one's visibility.
			expect(fs.readdirSync(root, { recursive: true })).not.toContain(
				expect.stringContaining("a.pdf"),
			);
		});

		it("prunes the folder itself once it is empty", async () => {
			await driver.put("invoices/a.pdf", Buffer.from("A"));

			await driver.deleteAll("invoices");

			expect(fs.existsSync(path.join(root, "invoices"))).toBe(false);
		});

		it("leaves a folder that still holds something", async () => {
			await driver.put("invoices/keep/a.pdf", Buffer.from("A"));

			// Only the direct children are listed by the prefix walk here;
			// a folder that is not empty afterwards must survive.
			await driver.deleteAll("invoices/keep");

			expect(fs.existsSync(path.join(root, "invoices"))).toBe(true);
		});

		it("does nothing for a prefix that holds nothing", async () => {
			await expect(driver.deleteAll("nothing/")).resolves.toBeUndefined();
		});
	});

	describe("moving a file", () => {
		it("carries its visibility across", async () => {
			await driver.put("a.txt", Buffer.from("x"));
			await driver.setVisibility("a.txt", "private");

			await driver.move("a.txt", "moved/b.txt");

			// Losing the sidecar on a move silently publishes a private file.
			expect(await driver.getVisibility("moved/b.txt")).toBe("private");
			expect(await driver.exists("a.txt")).toBe(false);
		});

		it("leaves no sidecar behind at the old path", async () => {
			await driver.put("a.txt", Buffer.from("x"));
			await driver.setVisibility("a.txt", "private");

			await driver.move("a.txt", "b.txt");

			const left = fs
				.readdirSync(root)
				.filter((name) => name.startsWith("a.txt"));
			expect(left).toEqual([]);
		});

		it("lets an explicit visibility win over the one it carried", async () => {
			await driver.put("a.txt", Buffer.from("x"));
			await driver.setVisibility("a.txt", "private");

			await driver.move("a.txt", "b.txt", { visibility: "public" });

			expect(await driver.getVisibility("b.txt")).toBe("public");
		});

		it("creates the destination folder", async () => {
			await driver.put("a.txt", Buffer.from("x"));

			await driver.move("a.txt", "deep/nested/b.txt");

			expect((await driver.get("deep/nested/b.txt"))?.toString()).toBe("x");
		});
	});

	describe("copying a file", () => {
		it("does not carry the source's visibility", async () => {
			await driver.put("a.txt", Buffer.from("x"));
			await driver.setVisibility("a.txt", "private");

			await driver.copy("a.txt", "b.txt");

			// A copy is a new object: it takes the default unless asked.
			expect(await driver.getVisibility("b.txt")).toBe("public");
		});

		it("takes an explicit visibility", async () => {
			await driver.put("a.txt", Buffer.from("x"));

			await driver.copy("a.txt", "b.txt", { visibility: "private" });

			expect(await driver.getVisibility("b.txt")).toBe("private");
		});
	});

	describe("the rest of the surface", () => {
		it("writes with a visibility in one call", async () => {
			await driver.put("a.txt", Buffer.from("x"), { visibility: "private" });

			expect(await driver.getVisibility("a.txt")).toBe("private");
		});

		it("hands back bytes, and says so when there are none", async () => {
			await driver.put("a.txt", Buffer.from("hello"));

			expect(Buffer.from(await driver.getBytes("a.txt")).toString()).toBe(
				"hello",
			);
			await expect(driver.getBytes("missing.txt")).rejects.toMatchObject({
				code: "E_ARCHIVE_NOT_FOUND",
			});
		});

		it("refuses to hand out a presigned upload URL it cannot honour", () => {
			// Returning something unusable would fail at the browser, with no
			// indication that local storage never supported this.
			expect(() => driver.getSignedUploadUrl("a.txt")).toThrow(
				/does not support presigned upload URLs/,
			);
		});

		it("blocks a path that climbs out of the root", async () => {
			await expect(
				driver.put("../escaped.txt", Buffer.from("x")),
			).rejects.toThrow(/Path traversal blocked/);
		});
	});
});

describe("archive > the manager over a disk", () => {
	let root: string;
	let disk: StorageManager;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-mgr-"));
		disk = new StorageManager(
			new LocalDriver(root, { signingSecret: "s".repeat(32) }),
		);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("passes every read and write through to the driver", async () => {
		await disk.put("a.txt", Buffer.from("hello"));

		expect((await disk.get("a.txt"))?.toString()).toBe("hello");
		expect(Buffer.from(await disk.getBytes("a.txt")).toString()).toBe("hello");
		expect(Buffer.from(await disk.getArrayBuffer("a.txt")).toString()).toBe(
			"hello",
		);
		expect(await disk.exists("a.txt")).toBe(true);
		expect(await disk.getVisibility("a.txt")).toBe("public");
		expect(await disk.getMetadata("a.txt")).toMatchObject({ size: 5 });
	});

	it("passes the bulk operations through", async () => {
		await disk.put("f/a.txt", Buffer.from("A"));
		await disk.put("f/b.txt", Buffer.from("B"));

		expect([...(await disk.listAll("f")).objects]).toHaveLength(2);
		const listed: string[] = [];
		for await (const entry of disk.list("f/")) listed.push(entry.path);
		expect(listed).toHaveLength(2);

		await disk.copy("f/a.txt", "f/c.txt");
		await disk.move("f/c.txt", "f/d.txt");
		expect(await disk.exists("f/d.txt")).toBe(true);

		await disk.deleteAll("f/");
		expect(await disk.exists("f/a.txt")).toBe(false);
	});

	it("takes a stream in and gives one back", async () => {
		await disk.putStream("a.txt", Readable.from([Buffer.from("streamed")]));

		const chunks: Buffer[] = [];
		for await (const chunk of await disk.getStream("a.txt")) {
			chunks.push(Buffer.from(chunk));
		}
		expect(Buffer.concat(chunks).toString()).toBe("streamed");
	});

	it("copies a file in from the filesystem, and moves one in", async () => {
		const source = path.join(root, "..", `source-${process.pid}.txt`);
		fs.writeFileSync(source, "from disk");

		await disk.copyFromFs(source, "copied.txt");
		expect((await disk.get("copied.txt"))?.toString()).toBe("from disk");
		// The source survives a copy.
		expect(fs.existsSync(source)).toBe(true);

		await disk.moveFromFs(source, "moved.txt");
		expect((await disk.get("moved.txt"))?.toString()).toBe("from disk");
		// And is gone after a move — but only once the write succeeded.
		expect(fs.existsSync(source)).toBe(false);
	});

	it("keeps the source when the write into the disk failed", async () => {
		const source = path.join(root, "..", `keep-${process.pid}.txt`);
		fs.writeFileSync(source, "precious");

		// A failed upload that also destroyed the only copy is not a trade
		// anyone would take.
		await expect(disk.moveFromFs(source, "../escaped.txt")).rejects.toThrow();
		expect(fs.existsSync(source)).toBe(true);
		fs.unlinkSync(source);
	});

	it("flips and reports visibility, and builds a URL", async () => {
		await disk.put("a.txt", Buffer.from("x"));

		await disk.setVisibility("a.txt", "private");
		expect(await disk.getVisibility("a.txt")).toBe("private");
		expect(await disk.url("a.txt")).toContain("a.txt");
		expect(await disk.getUrl("a.txt")).toBe(await disk.url("a.txt"));
		expect(disk.publicUrl("a.txt")).toContain("a.txt");
		expect(disk.getSignedUrl("a.txt")).toContain("sig=");
	});

	it("refuses a presigned upload URL the local disk cannot honour", () => {
		expect(() => disk.getSignedUploadUrl("a.txt")).toThrow(
			/does not support presigned upload URLs/,
		);
	});
});
