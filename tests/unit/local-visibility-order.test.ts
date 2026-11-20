/**
 * A private object on the local disk is never readable as public.
 *
 * The visibility marker is a second file beside the data, and its absence
 * means public. Writing the data first and the marker second left a window in
 * which a private upload was public — served unsigned by the signed route and
 * by a static server mounted over the disk — and a marker write that failed
 * left the object public for good. These tests pin the order: a private
 * marker lands BEFORE the data, and a failure leaves the object private or
 * absent.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDriver } from "../../src/index.js";
import { VISIBILITY_SIDECAR_SUFFIX } from "../../src/StorageManager.js";

let root: string;
let driver: LocalDriver;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-visibility-order-"));
	driver = new LocalDriver(root, { signingSecret: "x".repeat(32) });
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Make the marker of `key` unwritable: a link at the marker's name pointing
 * into a directory that does not exist. Whichever way the marker is written —
 * following the link (ENOENT) or refusing it (ELOOP) — the write fails, and a
 * read of the marker finds nothing, which is what a lost marker looks like.
 */
function breakMarker(key: string): void {
	const marker = path.join(root, key) + VISIBILITY_SIDECAR_SUFFIX;
	fs.mkdirSync(path.dirname(marker), { recursive: true });
	fs.symlinkSync(path.join(root, "missing-dir", "marker.json"), marker);
}

/**
 * The visibility a reader sees for `key`, or `"absent"` when there is no
 * object to serve. A marker that cannot be read is refused by the driver,
 * which serves nothing either.
 */
async function servedAs(key: string): Promise<string> {
	if (!fs.existsSync(path.join(root, key))) return "absent";
	try {
		return await driver.getVisibility(key);
	} catch {
		return "unreadable";
	}
}

describe("archive > LocalDriver writes a private marker before the data", () => {
	it("is never public while a private put() is being written", async () => {
		const key = "invoices/secret.pdf";
		const probe = await fsp.open(path.join(root, "probe"), "w");
		const handle: fsp.FileHandle = Object.getPrototypeOf(probe);
		await probe.close();
		const write = handle.writeFile;
		const observed: string[] = [];
		vi.spyOn(handle, "writeFile").mockImplementation(async function (
			this: fsp.FileHandle,
			data,
			options,
		) {
			// Every write the driver issues is observed from outside, as a
			// concurrent request would see the disk at that instant.
			observed.push(await servedAs(key));
			return write.call(this, data, options);
		});

		await driver.put(key, Buffer.alloc(64 * 1024, 1), {
			visibility: "private",
		});

		expect(observed).not.toContain("public");
		expect(await driver.getVisibility(key)).toBe("private");
	});

	it("leaves a private put() private or absent when the marker cannot be written", async () => {
		const key = "invoices/lost-marker.pdf";
		breakMarker(key);

		await expect(
			driver.put(key, "top secret", { visibility: "private" }),
		).rejects.toThrow();

		expect(["absent", "private", "unreadable"]).toContain(await servedAs(key));
	});

	it("does not overwrite a public file with private bytes it cannot mark", async () => {
		const key = "shared/report.pdf";
		await driver.put(key, "public draft");
		breakMarker(key);

		await expect(
			driver.put(key, "private final", { visibility: "private" }),
		).rejects.toThrow();

		// The object is still the public one it was: the private bytes never
		// landed under a public name.
		expect((await driver.get(key))?.toString()).toBe("public draft");
	});

	it("removes the data of a private put() whose write fails, with its marker", async () => {
		const key = "invoices/failed.pdf";
		const probe = await fsp.open(path.join(root, "probe"), "w");
		const handle: fsp.FileHandle = Object.getPrototypeOf(probe);
		await probe.close();
		const write = handle.writeFile;
		vi.spyOn(handle, "writeFile").mockImplementation(async function (
			this: fsp.FileHandle,
			data,
			options,
		) {
			// The marker goes through; the data write fails half-way.
			if (fs.existsSync(path.join(root, key))) {
				await write.call(this, "half", options);
				throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
			}
			return write.call(this, data, options);
		});

		await expect(
			driver.put(key, "top secret", { visibility: "private" }),
		).rejects.toThrow(/no space left/);

		expect(fs.existsSync(path.join(root, key))).toBe(false);
		// No orphan marker left to make the next upload of that key private.
		expect(
			fs.existsSync(path.join(root, key) + VISIBILITY_SIDECAR_SUFFIX),
		).toBe(false);
	});

	it("does not publish a private copy() whose marker cannot be written", async () => {
		await driver.put("src.pdf", "top secret", { visibility: "private" });
		await driver.put("dst.pdf", "public draft");
		breakMarker("dst.pdf");

		await expect(
			driver.copy("src.pdf", "dst.pdf", { visibility: "private" }),
		).rejects.toThrow();

		expect((await driver.get("dst.pdf"))?.toString()).toBe("public draft");
	});

	it("does not publish a moved private file whose target marker cannot be written", async () => {
		await driver.put("src.pdf", "top secret", { visibility: "private" });
		breakMarker("moved/dst.pdf");

		await expect(driver.move("src.pdf", "moved/dst.pdf")).rejects.toThrow();

		expect(["absent", "private", "unreadable"]).toContain(
			await servedAs("moved/dst.pdf"),
		);
		// Nothing moved: the source is still there, still private.
		expect(await driver.getVisibility("src.pdf")).toBe("private");
		expect((await driver.get("src.pdf"))?.toString()).toBe("top secret");
	});

	it("still moves a private file and keeps it private", async () => {
		await driver.put("a.pdf", "top secret", { visibility: "private" });

		await driver.move("a.pdf", "b/a.pdf");

		expect(await driver.getVisibility("b/a.pdf")).toBe("private");
		expect(await driver.exists("a.pdf")).toBe(false);
		expect(
			fs.existsSync(path.join(root, "a.pdf") + VISIBILITY_SIDECAR_SUFFIX),
		).toBe(false);
	});

	it("restores the target's marker when a private move() fails", async () => {
		await driver.put("src.pdf", "top secret", { visibility: "private" });
		// A directory at the target name: the rename fails after the marker
		// was written for it.
		fs.mkdirSync(path.join(root, "dst.pdf", "inner"), { recursive: true });

		await expect(driver.move("src.pdf", "dst.pdf")).rejects.toThrow();

		expect(
			fs.existsSync(path.join(root, "dst.pdf") + VISIBILITY_SIDECAR_SUFFIX),
		).toBe(false);
		expect(await driver.getVisibility("src.pdf")).toBe("private");
	});

	it("makes a public file private before it overwrites it", async () => {
		const key = "shared/flip.pdf";
		await driver.put(key, "public draft");
		const probe = await fsp.open(path.join(root, "probe"), "w");
		const handle: fsp.FileHandle = Object.getPrototypeOf(probe);
		await probe.close();
		const write = handle.writeFile;
		const observed: string[] = [];
		vi.spyOn(handle, "writeFile").mockImplementation(async function (
			this: fsp.FileHandle,
			data,
			options,
		) {
			observed.push(await servedAs(key));
			return write.call(this, data, options);
		});

		await driver.put(key, "private final", { visibility: "private" });

		// The last write is the data's: by then the object reads as private.
		expect(observed.at(-1)).toBe("private");
		expect(await driver.getVisibility(key)).toBe("private");
	});

	it("keeps a private file private until a public overwrite has landed", async () => {
		const key = "shared/release.pdf";
		await driver.put(key, "private draft", { visibility: "private" });
		const probe = await fsp.open(path.join(root, "probe"), "w");
		const handle: fsp.FileHandle = Object.getPrototypeOf(probe);
		await probe.close();
		const write = handle.writeFile;
		const observed: string[] = [];
		vi.spyOn(handle, "writeFile").mockImplementation(async function (
			this: fsp.FileHandle,
			data,
			options,
		) {
			observed.push(await servedAs(key));
			return write.call(this, data, options);
		});

		await driver.put(key, "public release", { visibility: "public" });

		// While the new bytes were written, the old private ones (or a mix of
		// both) were still marked private.
		expect(observed[0]).toBe("private");
		expect(await driver.getVisibility(key)).toBe("public");
	});
});
