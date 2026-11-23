import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BodyParserMiddleware,
	ConfigStore,
	Container,
	HttpContext,
	MultipartFile,
	type RawRequest,
} from "@c9up/ream";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArchiveProvider from "../../src/ArchiveProvider.js";
import { type DriveConfig, services } from "../../src/DriveManager.js";
import { StorageManager } from "../../src/index.js";

/**
 * `moveToDisk` on a real upload: the body parser builds the MultipartFile from
 * a multipart payload, the provider's boot attaches the macro, and the bytes
 * land in a local disk under a temp directory.
 */

const roots: string[] = [];
let provider: ArchiveProvider | undefined;

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-move-to-disk-"));
	roots.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await provider?.shutdown();
	provider = undefined;
	Reflect.deleteProperty(MultipartFile.prototype, "moveToDisk");
	for (const dir of roots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface Disks {
	/** Root of the default disk, `local`. */
	local: string;
	/** Root of the second disk, `uploads`. */
	uploads: string;
}

/** Boot the provider over two local disks, both able to sign URLs. */
async function boot(): Promise<Disks> {
	const disks = { local: tempRoot(), uploads: tempRoot() };
	const archive: DriveConfig = {
		default: "local",
		services: {
			local: services.fs({
				location: disks.local,
				signingSecret: "a".repeat(32),
			}),
			uploads: services.fs({
				location: disks.uploads,
				signingSecret: "b".repeat(32),
				routeBasePath: "/uploads",
			}),
		},
	};
	const config = new ConfigStore();
	config.set("archive", archive);
	provider = new ArchiveProvider({ container: new Container(), config });
	provider.register();
	await provider.boot();
	return disks;
}

/** Parse a one-file multipart request through ream's body parser. */
async function upload(content = "hello"): Promise<MultipartFile> {
	const raw: RawRequest = {
		method: "POST",
		path: "/",
		query: "",
		headers: {
			"content-type": "multipart/form-data; boundary=x",
			"content-length": "1",
		},
		body: "",
		multipart: {
			fields: [],
			files: [
				{
					fieldName: "avatar",
					clientName: "me.txt",
					contentType: "text/plain",
					size: Buffer.byteLength(content),
					contentB64: Buffer.from(content).toString("base64"),
				},
			],
		},
	};
	const ctx = new HttpContext(
		"test",
		raw,
		{},
		{ pattern: "/", middleware: [] },
	);
	await new BodyParserMiddleware().handle(ctx, async () => {});
	const file = ctx.request.file("avatar");
	if (!(file instanceof MultipartFile)) throw new Error("no upload parsed");
	return file;
}

describe("MultipartFile.moveToDisk", () => {
	it("needs a ream whose MultipartFile takes macros", () => {
		// The published ream may predate it: this fails loudly instead of the
		// suite below failing for a reason it does not name.
		expect(
			typeof Reflect.get(MultipartFile, "macro"),
			"the installed @c9up/ream has no MultipartFile.macro — upgrade it",
		).toBe("function");
	});

	it("streams an upload into the default disk and records its URL", async () => {
		const disks = await boot();
		const putStream = vi.spyOn(StorageManager.prototype, "putStream");
		const file = await upload();

		await file.moveToDisk("/avatars//me.txt");

		expect(
			fs.readFileSync(path.join(disks.local, "avatars/me.txt"), "utf8"),
		).toBe("hello");
		expect(putStream).toHaveBeenCalledTimes(1);
		expect(file.isMoved).toBe(true);
		expect(file.state).toBe("moved");
		expect(file.fileName).toBe("avatars/me.txt");
		expect(file.filePath).toBe("avatars/me.txt");
		expect(file.meta.url).toBe("/storage/avatars/me.txt");
	});

	it("writes into the named disk, with the visibility it was asked for", async () => {
		const disks = await boot();
		const putStream = vi.spyOn(StorageManager.prototype, "putStream");
		const file = await upload("secret");

		await file.moveToDisk("docs/me.txt", "uploads", { visibility: "private" });

		expect(
			fs.readFileSync(path.join(disks.uploads, "docs/me.txt"), "utf8"),
		).toBe("secret");
		expect(fs.existsSync(path.join(disks.local, "docs/me.txt"))).toBe(false);
		// Through put(), so the object is never public, not even for a moment.
		expect(putStream).not.toHaveBeenCalled();
		const archive = new StorageManager(
			services.fs({ location: disks.uploads })(),
		);
		expect(await archive.getVisibility("docs/me.txt")).toBe("private");
		expect(file.meta.url).toMatch(/^\/uploads\/docs\/me\.txt\?exp=\d+&sig=/);
	});

	it("takes the options alone for the default disk, and moveAs 'buffer'", async () => {
		const disks = await boot();
		const put = vi.spyOn(StorageManager.prototype, "put");
		const file = await upload();

		await file.moveToDisk("plain.txt", { moveAs: "buffer" });

		expect(fs.readFileSync(path.join(disks.local, "plain.txt"), "utf8")).toBe(
			"hello",
		);
		expect(put).toHaveBeenCalledTimes(1);
	});

	it.each([
		["../escape.txt", "E_PATH_TRAVERSAL_DETECTED"],
		["avatars/%2e%2e/%2e%2e/escape.txt", "E_PATH_TRAVERSAL_DETECTED"],
		["avatars\\..\\..\\escape.txt", "E_UNALLOWED_CHARACTERS"],
		["a/%2f/escape.txt", "E_UNALLOWED_CHARACTERS"],
		["//", "E_INVALID_KEY"],
	])("refuses the key %j with %s, writing nothing", async (key, code) => {
		const disks = await boot();
		const file = await upload();

		await expect(file.moveToDisk(key)).rejects.toMatchObject({ code });

		expect(file.isMoved).toBe(false);
		expect(file.meta.url).toBeUndefined();
		expect(fs.readdirSync(disks.local)).toEqual([]);
		expect(
			fs.existsSync(path.join(path.dirname(disks.local), "escape.txt")),
		).toBe(false);
	});

	it("refuses a disk that is not configured", async () => {
		await boot();
		const file = await upload();

		await expect(file.moveToDisk("a.txt", "s3")).rejects.toMatchObject({
			code: "E_ARCHIVE_UNKNOWN_DISK",
		});
		expect(file.isMoved).toBe(false);
	});

	it.each([
		[["a.txt", { visibility: "privat" }]],
		[["a.txt", "local", { moveAs: "file" }]],
		[["a.txt", { contentType: 42 }]],
		[["a.txt", { contentLength: -1 }]],
		[["a.txt", { visibility: "public" }, { visibility: "private" }]],
	])("refuses the options %j instead of ignoring them", async (args) => {
		const disks = await boot();
		const file = await upload();
		const moveToDisk: unknown = Reflect.get(file, "moveToDisk");
		if (typeof moveToDisk !== "function") throw new Error("no macro");

		await expect(Reflect.apply(moveToDisk, file, args)).rejects.toMatchObject({
			code: "E_ARCHIVE_INVALID_MOVE_OPTIONS",
		});
		expect(file.isMoved).toBe(false);
		expect(fs.readdirSync(disks.local)).toEqual([]);
	});

	it("refuses a key that is not a string", async () => {
		await boot();
		const file = await upload();
		const moveToDisk: unknown = Reflect.get(file, "moveToDisk");
		if (typeof moveToDisk !== "function") throw new Error("no macro");

		await expect(Reflect.apply(moveToDisk, file, [42])).rejects.toMatchObject({
			code: "E_ARCHIVE_INVALID_KEY",
		});
	});
});
