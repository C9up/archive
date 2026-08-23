/**
 * The flydrive surface a migrated app calls beyond put/get: a file handle, the
 * local-filesystem uploads that follow a multipart request, and snapshots.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDriver, StorageManager } from "../../src/StorageManager.js";

let root: string;
let tmp: string;
let disk: StorageManager;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-disk-"));
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archive-tmp-"));
	disk = new StorageManager(new LocalDriver(root));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("archive > file handle", () => {
	it("hands back a handle without reading anything", async () => {
		const handle = disk.file("missing.txt");
		expect(handle.key).toBe("missing.txt");
		expect(handle.name).toBe("missing.txt");
		expect(await handle.exists()).toBe(false);
	});

	it("reads through the handle once the file is there", async () => {
		await disk.put("notes/a.txt", "hello");
		const handle = disk.file("notes/a.txt");
		expect(handle.name).toBe("a.txt");
		expect(await handle.exists()).toBe(true);
		expect((await handle.get())?.toString()).toBe("hello");
		expect(Buffer.from(await handle.getArrayBuffer()).toString()).toBe("hello");
	});
});

describe("archive > uploads from the local filesystem", () => {
	it("copies a local file in and leaves the source alone", async () => {
		const source = path.join(tmp, "upload.txt");
		fs.writeFileSync(source, "payload");
		await disk.copyFromFs(source, "uploads/upload.txt");
		expect((await disk.get("uploads/upload.txt"))?.toString()).toBe("payload");
		expect(fs.existsSync(source)).toBe(true);
	});

	it("moves a local file in and removes the source", async () => {
		const source = path.join(tmp, "upload.txt");
		fs.writeFileSync(source, "payload");
		await disk.moveFromFs(source, "uploads/upload.txt");
		expect((await disk.get("uploads/upload.txt"))?.toString()).toBe("payload");
		expect(fs.existsSync(source)).toBe(false);
	});

	it("accepts a file: URL, as an import.meta.url path gives", async () => {
		const source = path.join(tmp, "url.txt");
		fs.writeFileSync(source, "via-url");
		await disk.copyFromFs(pathToFileURL(source), "uploads/url.txt");
		expect((await disk.get("uploads/url.txt"))?.toString()).toBe("via-url");
	});

	it("keeps the source when the write fails", async () => {
		const source = path.join(tmp, "keep.txt");
		fs.writeFileSync(source, "payload");
		await expect(disk.moveFromFs(source, "../escape.txt")).rejects.toThrow();
		expect(fs.existsSync(source)).toBe(true);
	});
});

describe("archive > snapshots", () => {
	it("round-trips a file through a snapshot", async () => {
		await disk.put("docs/report.pdf", "content");
		const snapshot = await disk.file("docs/report.pdf").toSnapshot();
		expect(snapshot.key).toBe("docs/report.pdf");
		expect(snapshot.name).toBe("report.pdf");
		expect(snapshot.contentLength).toBe(7);
		expect(typeof snapshot.lastModified).toBe("string");

		const rebuilt = disk.fromSnapshot(snapshot);
		expect(rebuilt.key).toBe("docs/report.pdf");
		// Rebuilt from the snapshot alone — no call to the provider.
		expect((await rebuilt.getMetaData()).contentLength).toBe(7);
	});

	it("survives JSON, which is the point of a snapshot", async () => {
		await disk.put("a.txt", "x");
		const snapshot = await disk.file("a.txt").toSnapshot();
		const revived = disk.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
		expect(revived.name).toBe("a.txt");
	});

	it("assumes private in the metadata a snapshot could not carry", async () => {
		await disk.put("a.txt", "x");
		const snapshot = await disk.file("a.txt").toSnapshot();
		// A snapshot has no visibility field, so the rebuilt metadata must not
		// claim "public" — asking the driver still reports the truth.
		expect((await disk.fromSnapshot(snapshot).getMetaData()).visibility).toBe(
			"private",
		);
	});
});
