import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GcsDriver,
	LocalDriver,
	S3Driver,
	StorageManager,
} from "../../src/index.js";
import {
	FakeStorage,
	FakeStorageManager,
} from "../../src/testing/FakeStorage.js";

/** Stored on every disk; only the first is under `users/1`. */
const BUCKET = [
	"users/1/avatar.png",
	"users/10/avatar.png",
	"users/1337/passport.pdf",
	"users/2/avatar.png",
];
const SIBLINGS = BUCKET.slice(1);

describe("archive > a prefix names a directory", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["users/1", "users/1/"])(
		"local disk: deleteAll(%j) deletes users/1 and leaves its siblings",
		async (prefix) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-prefix-"));
			try {
				const disk = new StorageManager(new LocalDriver(root));
				for (const key of BUCKET) await disk.put(key, key);
				await disk.deleteAll(prefix);
				expect(await disk.exists("users/1/avatar.png")).toBe(false);
				for (const key of SIBLINGS) expect(await disk.exists(key)).toBe(true);
				// The emptied directory is pruned, the siblings' are not.
				expect(fs.existsSync(path.join(root, "users/1"))).toBe(false);
				expect(fs.existsSync(path.join(root, "users/10"))).toBe(true);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("local disk: list() and listAll() do not show a sibling's keys", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-prefix-"));
		try {
			const disk = new StorageManager(new LocalDriver(root));
			for (const key of BUCKET) await disk.put(key, key);
			const listed: string[] = [];
			for await (const entry of disk.list("users/1")) listed.push(entry.path);
			expect(listed).toEqual(["users/1/avatar.png"]);
			const { objects } = await disk.listAll("users/1", { recursive: true });
			expect([...objects].map((o) => (o.isFile ? o.key : o.prefix))).toEqual([
				"users/1/avatar.png",
			]);
			// The root is still everything.
			const all: string[] = [];
			for await (const entry of disk.list("")) all.push(entry.path);
			expect(all.sort()).toEqual([...BUCKET].sort());
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("S3: lists users/1/ and batch-deletes only what is under it", async () => {
		const driver = new S3Driver({
			bucket: "my-bucket",
			region: "us-east-1",
			accessKeyId: "AKIATEST",
			secretAccessKey: "secret",
		});
		const listed: string[] = [];
		let deleteBody = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new URL(String(input));
			if (url.searchParams.has("list-type")) {
				// What S3 does with a prefix: names that begin with it.
				const prefix = url.searchParams.get("prefix") ?? "";
				listed.push(prefix);
				const keys = BUCKET.filter((k) => k.startsWith(prefix));
				return new Response(
					`<ListBucketResult>${keys
						.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`)
						.join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
					{ status: 200 },
				);
			}
			const body = init?.body;
			deleteBody =
				body instanceof Uint8Array ? Buffer.from(body).toString() : "";
			return new Response("", { status: 200 });
		});

		await new StorageManager(driver).deleteAll("users/1");

		expect(listed).toEqual(["users/1/"]);
		expect(deleteBody).toContain("<Key>users/1/avatar.png</Key>");
		for (const key of SIBLINGS) expect(deleteBody).not.toContain(key);
	});

	it("GCS: lists users/1/ and deletes only what is under it", async () => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});
		const driver = new GcsDriver({
			bucket: "my-bucket",
			serviceAccount: {
				client_email: "test@test.iam.gserviceaccount.com",
				private_key: privateKey,
			},
		});
		const listed: string[] = [];
		const deleted: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new URL(String(input));
			if (url.hostname === "oauth2.googleapis.com") {
				return new Response(
					JSON.stringify({ access_token: "t", expires_in: 3600 }),
					{ status: 200 },
				);
			}
			if ((init?.method ?? "GET") === "GET" && url.searchParams.has("prefix")) {
				const prefix = url.searchParams.get("prefix") ?? "";
				listed.push(prefix);
				return new Response(
					JSON.stringify({
						items: BUCKET.filter((k) => k.startsWith(prefix)).map((name) => ({
							name,
							size: "1",
						})),
					}),
					{ status: 200 },
				);
			}
			if (init?.method === "DELETE") {
				deleted.push(decodeURIComponent(url.pathname.split("/o/")[1] ?? ""));
				return new Response(null, { status: 204 });
			}
			return new Response("unexpected", { status: 500 });
		});

		await new StorageManager(driver).deleteAll("users/1");

		expect(listed).toEqual(["users/1/"]);
		expect(deleted).toEqual(["users/1/avatar.png"]);
	});

	it("the fake: deleteAll and list read a prefix the same way", async () => {
		const fake = new FakeStorage();
		for (const key of BUCKET) await fake.put(key, key);
		const listed: string[] = [];
		for await (const entry of fake.list("users/1")) listed.push(entry.path);
		expect(listed).toEqual(["users/1/avatar.png"]);
		await fake.deleteAll("users/1");
		for (const key of SIBLINGS) expect(await fake.exists(key)).toBe(true);
		expect(await fake.exists("users/1/avatar.png")).toBe(false);

		const manager = new FakeStorageManager();
		for (const key of BUCKET) await manager.put(key, key);
		await manager.deleteAll("users/1");
		for (const key of SIBLINGS) expect(await manager.exists(key)).toBe(true);
	});
});
