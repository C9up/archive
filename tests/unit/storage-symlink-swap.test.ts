import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDriver } from "../../src/index.js";

/**
 * A symlink planted where the check already passed.
 *
 * `#safePath` canonicalises the path and confirms it is under the root, then
 * returns a STRING — and the read or write happened later, against that string.
 * Between the two, the last component can be replaced by a symlink pointing
 * anywhere: the check passed on one object and the I/O landed on another.
 *
 * The window is small but it is a window, and the file it points at is chosen
 * by whoever can write in the storage directory. Every I/O now goes through a
 * descriptor opened with O_NOFOLLOW, so the open refuses the link rather than
 * following it.
 *
 * A parent directory swapped in the same window is NOT covered: closing that
 * needs an open relative to a directory descriptor (`openat`), which Node does
 * not expose. `StaticMiddleware` documents the same boundary.
 */

let root: string;
let outside: string;
let driver: LocalDriver;

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-symlink-"));
	outside = await fsp.mkdtemp(path.join(os.tmpdir(), "storage-outside-"));
	driver = new LocalDriver(root, { signingSecret: "s3cr3t-s3cr3t-s3cr3t" });
});

afterEach(async () => {
	await fsp.rm(root, { recursive: true, force: true });
	await fsp.rm(outside, { recursive: true, force: true });
});

describe("archive > a symlink at the final component", () => {
	it("does not write through a DANGLING link, which the path check cannot see", async () => {
		// This one needs no race at all. `realpath` on a dangling symlink raises
		// ENOENT, so the check walks up to the parent, finds it under the root,
		// and approves — then the write followed the link and CREATED the file
		// it pointed at, outside the root.
		const target = path.join(outside, "created-outside.txt");
		await fsp.symlink(target, path.join(root, "note.txt"));

		await expect(driver.put("note.txt", "escaped")).rejects.toThrow();
		await expect(fsp.access(target)).rejects.toThrow();
	});

	it("does not stream into a dangling link either", async () => {
		const target = path.join(outside, "streamed-outside.txt");
		await fsp.symlink(target, path.join(root, "note.txt"));

		await expect(
			driver.putStream("note.txt", Readable.from(["escaped"])),
		).rejects.toThrow();
		await expect(fsp.access(target)).rejects.toThrow();
	});

	it("refuses a link planted over an existing file", async () => {
		// Caught by the path check as well, so this pins the belt AND the
		// braces: the open refuses the link even when the check has approved
		// the name, which is what closes the window between the two.
		const secret = path.join(outside, "secret.txt");
		await fsp.writeFile(secret, "original");
		const linkPath = path.join(root, "note.txt");
		await fsp.rm(linkPath, { force: true });
		await fsp.symlink(secret, linkPath);

		await expect(driver.put("note.txt", "overwritten")).rejects.toThrow();
		expect(await fsp.readFile(secret, "utf8")).toBe("original");
		await expect(driver.get("note.txt")).rejects.toThrow();
		await expect(driver.getStream("note.txt")).rejects.toThrow();
	});

	it("still serves a real file that is not a link", async () => {
		// The guard must not cost the ordinary case.
		await driver.put("real.txt", "hello");
		expect((await driver.get("real.txt"))?.toString()).toBe("hello");
		const stream = await driver.getStream("real.txt");
		const chunks: Buffer[] = [];
		for await (const chunk of stream) chunks.push(Buffer.from(chunk));
		expect(Buffer.concat(chunks).toString()).toBe("hello");
	});
});
