/**
 * The file handle a listing hands back, and the service accessor.
 *
 * `listAll` returns `DriveFile`s rather than paths precisely so a caller can
 * read one without knowing which disk it came from. Every one of those methods
 * was a shape in the type definitions; none had been called.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDriver, StorageManager } from "../../src/index.js";
import storage, { getStorage, setStorage } from "../../src/services/main.js";

describe("archive > the file handle from a listing", () => {
	let root: string;
	let driver: LocalDriver;

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-obj-"));
		driver = new LocalDriver(root, { signingSecret: "s".repeat(32) });
		await driver.put("docs/report.txt", Buffer.from("hello"));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const handle = async () => {
		const [file] = [
			...(await driver.listAll("docs", { recursive: true })).objects,
		];
		if (file === undefined || !file.isFile) throw new Error("expected a file");
		return file;
	};

	it("reads its own contents, in each form", async () => {
		const file = await handle();

		expect((await file.get())?.toString()).toBe("hello");
		expect(Buffer.from(await file.getBytes()).toString()).toBe("hello");
		expect(Buffer.from(await file.getArrayBuffer()).toString()).toBe("hello");

		const chunks: Buffer[] = [];
		for await (const chunk of await file.getStream()) {
			chunks.push(Buffer.from(chunk));
		}
		expect(Buffer.concat(chunks).toString()).toBe("hello");
	});

	it("answers from the snapshot the listing captured, without asking again", async () => {
		const file = await handle();
		// Delete the file: a metadata read that went back to the driver would
		// now fail, which is how a listing turns into N round-trips.
		await driver.delete("docs/report.txt");

		expect(await file.getMetaData()).toMatchObject({ size: 5 });
	});

	it("asks the driver when it holds no snapshot", async () => {
		const { DriveFile } = await import("../../src/objects.js");
		const file = new DriveFile("docs/report.txt", driver);

		expect(await file.getMetaData()).toMatchObject({ size: 5 });
	});

	it("reports its visibility and builds its URLs", async () => {
		const file = await handle();

		expect(await file.getVisibility()).toBe("public");
		expect(await file.getUrl()).toContain("report.txt");
		expect(await file.getSignedUrl()).toContain("sig=");
	});

	it("refuses an upload URL the disk cannot honour", async () => {
		const file = await handle();

		expect(() => file.getSignedUploadUrl()).toThrow(
			/does not support presigned upload URLs/,
		);
	});

	it("serialises to something worth storing beside a record", async () => {
		const file = await handle();

		const snapshot = await file.toSnapshot();

		// The point is to render a name and a size later without a round-trip
		// to the provider, so the snapshot has to carry both.
		expect(snapshot).toMatchObject({
			key: "docs/report.txt",
			name: "report.txt",
			contentLength: 5,
			contentType: "text/plain",
		});
		expect(new Date(snapshot.lastModified).getTime()).not.toBeNaN();
	});

	it("knows whether it exists", async () => {
		const file = await handle();

		expect(await file.exists()).toBe(true);
		await driver.delete("docs/report.txt");
		expect(await file.exists()).toBe(false);
	});
});

describe("archive > the service accessor", () => {
	afterEach(() => {
		setStorage(undefined as unknown as StorageManager);
	});

	it("answers undefined to a loader's probes instead of throwing", () => {
		// A module loader reads `then` to decide whether the namespace is
		// thenable, and symbols for interop. Throwing there turns a plain
		// import into a crash far from any real use.
		expect((storage as unknown as { then?: unknown }).then).toBeUndefined();
		expect(Reflect.get(storage, Symbol.toPrimitive)).toBeUndefined();
	});

	it("says what to wire when it is read before boot", () => {
		expect(() => storage.put).toThrow(
			/accessed before ArchiveProvider\.boot\(\)/,
		);
	});

	it("forwards to the bound manager, bound to it", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-svc-"));
		const manager = new StorageManager(new LocalDriver(root));
		setStorage(manager);

		expect(getStorage()).toBe(manager);
		// Unbound, the forwarded method would lose its private state.
		const { put, get } = storage;
		await put("a.txt", Buffer.from("hello"));
		expect((await get("a.txt"))?.toString()).toBe("hello");

		fs.rmSync(root, { recursive: true, force: true });
	});
});
