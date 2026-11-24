/**
 * Keys are normalised before ANY driver sees them.
 *
 * Only the local disk had a containment check, so `..`, a leading `/` and
 * `//` reached the cloud drivers raw: `publicUrl("../other-bucket/file.txt")`
 * produced a link every URL parser resolves into another bucket on the same
 * host, and `put("/a.txt")` created an object distinct from `a.txt`.
 */

import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DriveFile,
	GcsDriver,
	LocalDriver,
	S3Driver,
	StorageManager,
} from "../../src/index.js";
import { normalizeKey, normalizePrefix } from "../../src/keys.js";
import { FakeStorage } from "../../src/testing/FakeStorage.js";

const traversal = { code: "E_PATH_TRAVERSAL_DETECTED" };
const unallowed = { code: "E_UNALLOWED_CHARACTERS" };
const invalid = { code: "E_INVALID_KEY" };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("archive > key normalisation > the rules", () => {
	it("collapses separators and strips what does not name anything", () => {
		expect(normalizeKey("a//b///c.txt")).toBe("a/b/c.txt");
		expect(normalizeKey("/a.txt")).toBe("a.txt");
		expect(normalizeKey("a/")).toBe("a");
		expect(normalizeKey("./a/./b.txt")).toBe("a/b.txt");
		// Wider than a strict whitelist: spaces, unicode and dotfiles are names.
		expect(normalizeKey("photos/été 2024/.hidden")).toBe(
			"photos/été 2024/.hidden",
		);
	});

	it("refuses every way of climbing out", () => {
		for (const key of [
			"..",
			"../x",
			"a/../b",
			"a/..",
			"a/.../b",
			"%2e%2e/x",
			"a/%2E%2e/b",
			".%2e/x",
		]) {
			expect(() => normalizeKey(key), key).toThrow(
				expect.objectContaining(traversal),
			);
		}
	});

	it("refuses separators and control characters it cannot represent", () => {
		for (const key of [
			"a\\b",
			"..\\x",
			"a%2fb",
			"a%5Cb",
			"a\0b",
			"a%00b",
			"a\nb",
			"a\rb",
			"a\tb",
			"a\x7fb",
		]) {
			expect(() => normalizeKey(key), JSON.stringify(key)).toThrow(
				expect.objectContaining(unallowed),
			);
		}
	});

	it("refuses a key that names nothing", () => {
		for (const key of ["", "/", "//", "./", "."]) {
			expect(() => normalizeKey(key), key).toThrow(
				expect.objectContaining(invalid),
			);
		}
	});

	it("reads a prefix as a directory and lets the root be listed", () => {
		expect(normalizePrefix("")).toBe("");
		expect(normalizePrefix("/")).toBe("");
		expect(normalizePrefix("avatars//42/")).toBe("avatars/42/");
		expect(normalizePrefix("/avatars/4")).toBe("avatars/4/");
		expect(() => normalizePrefix("../")).toThrow(
			expect.objectContaining(traversal),
		);
	});
});

describe("archive > key normalisation > the cloud drivers", () => {
	const s3 = () =>
		new S3Driver({
			bucket: "mybucket",
			region: "eu-west-3",
			accessKeyId: "AK",
			secretAccessKey: "SK",
		});

	it("never builds an S3 link that leaves the bucket", () => {
		expect(() => s3().publicUrl("../other-bucket/file.txt")).toThrow(
			expect.objectContaining(traversal),
		);
		expect(() => s3().getSignedUrl("../other-bucket/file.txt")).toThrow(
			expect.objectContaining(traversal),
		);
		expect(s3().publicUrl("/a.txt")).toBe(s3().publicUrl("a.txt"));
	});

	it("sends a normalised key to S3, and nothing for a traversal", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return new Response("", { status: 200 });
		});
		await s3().put("/a.txt", "x");
		await s3().put("dir//b.txt", "x");
		expect(urls).toEqual([
			"https://s3.eu-west-3.amazonaws.com/mybucket/a.txt",
			"https://s3.eu-west-3.amazonaws.com/mybucket/dir/b.txt",
		]);
		await expect(s3().put("a/../b", "x")).rejects.toMatchObject(traversal);
		await expect(s3().copy("a.txt", "../b.txt")).rejects.toMatchObject(
			traversal,
		);
		expect(urls).toHaveLength(2);
	});

	it("sends a normalised key to GCS, and nothing for a traversal", async () => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		const gcs = new GcsDriver({
			bucket: "b",
			serviceAccount: { client_email: "a@b.test", private_key: privateKey },
		});
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return new Response(
				JSON.stringify({ access_token: "t", expires_in: 3600 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		await gcs.put("/a.txt", "x");
		expect(urls.at(-1)).toContain("name=a.txt");
		expect(() => gcs.publicUrl("../other/x")).toThrow(
			expect.objectContaining(traversal),
		);
		const before = urls.length;
		await expect(gcs.put("a/../b", "x")).rejects.toMatchObject(traversal);
		await expect(gcs.delete("../b")).rejects.toMatchObject(traversal);
		expect(urls).toHaveLength(before);
	});
});

describe("archive > key normalisation > the manager and file handles", () => {
	it("makes '/a.txt' and 'a.txt' the same object", async () => {
		const storage = new StorageManager(new FakeStorage());
		await storage.put("/a.txt", "x");
		expect(await storage.exists("a.txt")).toBe(true);
		expect(await storage.exists("//a.txt")).toBe(true);
		await expect(storage.put("../a.txt", "x")).rejects.toMatchObject(traversal);
	});

	it("normalises a file handle's key", () => {
		const driver = new FakeStorage();
		expect(new DriveFile("/a//b.txt", driver).key).toBe("a/b.txt");
		expect(() => new DriveFile("../x", driver)).toThrow(
			expect.objectContaining(traversal),
		);
	});

	it("keeps a leading-slash key inside the local root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-keys-"));
		try {
			const driver = new LocalDriver(root);
			await driver.put("/etc/archive-probe.txt", "x");
			expect(
				fs.readFileSync(path.join(root, "etc/archive-probe.txt"), "utf8"),
			).toBe("x");
			expect(driver.publicUrl("/a//b.txt")).toBe("/storage/a/b.txt");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
