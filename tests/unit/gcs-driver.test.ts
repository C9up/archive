import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GcsDriver } from "../../src/index.js";

async function drainStream(readable: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of readable) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}
	return Buffer.concat(chunks);
}

function buildDriver() {
	// Fresh RSA-2048 per test — no hard-coded private key on disk or in
	// the repo. Each `beforeEach` generates a new pair.
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	return new GcsDriver({
		bucket: "my-bucket",
		serviceAccount: {
			client_email: "test@test.iam.gserviceaccount.com",
			private_key: privateKey,
		},
	});
}

function tokenResponse() {
	return new Response(
		JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("GcsDriver", () => {
	let driver: GcsDriver;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		driver = buildDriver();
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	describe("auth", () => {
		it("exchanges a JWT for an access token on first call", async () => {
			fetchSpy.mockResolvedValueOnce(tokenResponse());
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.put("hello.txt", Buffer.from("hi"));
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0] ?? [];
			expect(String(tokenUrl)).toBe("https://oauth2.googleapis.com/token");
			const body = (tokenInit as RequestInit).body as string;
			expect(body).toContain(
				"grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
			);
			// Parse the JWT's claim section to verify required fields.
			const params = new URLSearchParams(body);
			const jwt = params.get("assertion") ?? "";
			const [, claimB64] = jwt.split(".");
			const claim = JSON.parse(
				Buffer.from(claimB64 ?? "", "base64url").toString("utf8"),
			) as {
				iss: string;
				scope: string;
				aud: string;
				exp: number;
				iat: number;
			};
			expect(claim.iss).toBe("test@test.iam.gserviceaccount.com");
			expect(claim.aud).toBe("https://oauth2.googleapis.com/token");
			expect(claim.scope).toContain("devstorage.read_write");
			expect(claim.exp).toBeGreaterThan(claim.iat);
		});

		it("reuses the cached token on subsequent calls", async () => {
			fetchSpy.mockResolvedValueOnce(tokenResponse());
			fetchSpy.mockResolvedValue(new Response("", { status: 200 }));
			await driver.put("a.txt", Buffer.from("a"));
			await driver.put("b.txt", Buffer.from("b"));
			// 1 token + 2 API calls = 3 total; token exchange happened once.
			expect(fetchSpy).toHaveBeenCalledTimes(3);
			expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
				"https://oauth2.googleapis.com/token",
			);
			expect(String(fetchSpy.mock.calls[1]?.[0])).not.toContain("oauth2");
			expect(String(fetchSpy.mock.calls[2]?.[0])).not.toContain("oauth2");
		});
	});

	describe("CRUD", () => {
		beforeEach(() => {
			fetchSpy.mockResolvedValueOnce(tokenResponse());
		});

		it("put issues POST /upload/.../o?uploadType=media with Bearer auth", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.put("folder/cat.png", Buffer.from("png-bytes"));
			const [url, init] = fetchSpy.mock.calls[1] ?? [];
			expect(String(url)).toContain(
				"/upload/storage/v1/b/my-bucket/o?uploadType=media&name=folder%2Fcat.png",
			);
			expect((init as RequestInit).method).toBe("POST");
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers.authorization).toBe("Bearer test-token");
			expect(headers["content-type"]).toBe("image/png");
		});

		it("get returns Buffer body on 200", async () => {
			const body = new Uint8Array([1, 2, 3]);
			fetchSpy.mockResolvedValueOnce(new Response(body, { status: 200 }));
			const loaded = await driver.get("file.bin");
			expect(loaded).not.toBeNull();
			expect(Array.from(loaded ?? [])).toEqual([1, 2, 3]);
		});

		it("get returns null on 404", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			expect(await driver.get("missing")).toBeNull();
		});

		it("delete returns true on 200/204", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
			expect(await driver.delete("gone.txt")).toBe(true);
		});

		it("delete returns false on 404", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			expect(await driver.delete("gone.txt")).toBe(false);
		});

		it("exists returns true on 200", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			expect(await driver.exists("there")).toBe(true);
		});

		it("exists returns false on 404", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			expect(await driver.exists("gone")).toBe(false);
		});

		it("exists throws on 403/5xx — does NOT silently return false", async () => {
			// Swallowing access errors as "not found" would mask a config
			// problem (bad auth scopes) behind a silent false result.
			fetchSpy.mockResolvedValueOnce(new Response("denied", { status: 403 }));
			await expect(driver.exists("protected")).rejects.toThrow(
				/GCS EXISTS failed/,
			);
		});
	});

	describe("metadata + visibility", () => {
		beforeEach(() => {
			fetchSpy.mockResolvedValueOnce(tokenResponse());
		});

		const publicAclJson = {
			size: "1234",
			contentType: "image/png",
			updated: "2015-10-21T07:28:00Z",
			etag: '"abc123"',
			acl: [{ entity: "allUsers", role: "READER" }],
		};
		const privateAclJson = {
			size: "10",
			contentType: "text/plain",
			updated: "2015-10-21T07:28:00Z",
			etag: '"xyz"',
			acl: [{ entity: "user-owner", role: "OWNER" }],
		};

		it("getMetadata returns public visibility when ACL has allUsers READER", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(publicAclJson), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			const meta = await driver.getMetadata("cat.png");
			expect(meta.size).toBe(1234);
			expect(meta.mimeType).toBe("image/png");
			expect(meta.lastModified).toEqual(new Date("2015-10-21T07:28:00Z"));
			expect(meta.etag).toBe("abc123");
			expect(meta.visibility).toBe("public");
		});

		it("getMetadata returns private when ACL has no allUsers", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(privateAclJson), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			const meta = await driver.getMetadata("cat.png");
			expect(meta.visibility).toBe("private");
		});

		it("getMetadata on 404 throws E_ARCHIVE_NOT_FOUND", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			await expect(driver.getMetadata("missing")).rejects.toMatchObject({
				code: "E_ARCHIVE_NOT_FOUND",
			});
		});

		it("setVisibility('public') POSTs /acl with { allUsers, READER }", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.setVisibility("cat.png", "public");
			const [url, init] = fetchSpy.mock.calls[1] ?? [];
			expect(String(url)).toContain("/storage/v1/b/my-bucket/o/cat.png/acl");
			expect((init as RequestInit).method).toBe("POST");
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body).toEqual({ entity: "allUsers", role: "READER" });
		});

		it("setVisibility('private') DELETEs /acl/allUsers", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
			await driver.setVisibility("cat.png", "private");
			const [url, init] = fetchSpy.mock.calls[1] ?? [];
			expect(String(url)).toContain(
				"/storage/v1/b/my-bucket/o/cat.png/acl/allUsers",
			);
			expect((init as RequestInit).method).toBe("DELETE");
		});

		it("setVisibility('private') treats 404 as idempotent success", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			await expect(
				driver.setVisibility("cat.png", "private"),
			).resolves.toBeUndefined();
		});
	});

	describe("getSignedUrl (V4)", () => {
		it("returns a URL with all 5 X-Goog-* params plus X-Goog-Signature", () => {
			const url = driver.getSignedUrl("folder/cat.png");
			const parsed = new URL(url);
			expect(parsed.pathname).toBe("/my-bucket/folder/cat.png");
			expect(parsed.searchParams.get("X-Goog-Algorithm")).toBe(
				"GOOG4-RSA-SHA256",
			);
			expect(parsed.searchParams.get("X-Goog-SignedHeaders")).toBe("host");
			expect(parsed.searchParams.get("X-Goog-Expires")).toBe("300");
			expect(parsed.searchParams.get("X-Goog-Credential")).toMatch(
				/test@test\.iam\.gserviceaccount\.com\/\d{8}\/auto\/storage\/goog4_request/,
			);
			expect(parsed.searchParams.get("X-Goog-Date")).toMatch(/^\d{8}T\d{6}Z$/);
			// RSA-2048 produces 256-byte signatures → 512 hex chars.
			expect(parsed.searchParams.get("X-Goog-Signature")).toMatch(
				/^[a-f0-9]{512}$/,
			);
		});

		it("honours a custom expiresIn", () => {
			const url = driver.getSignedUrl("x", { expiresIn: 60 });
			expect(new URL(url).searchParams.get("X-Goog-Expires")).toBe("60");
		});

		it.each([
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			604_801,
		])("rejects out-of-range expiresIn (%s)", (bad) => {
			expect(() =>
				driver.getSignedUrl("x", { expiresIn: bad as number }),
			).toThrow(expect.objectContaining({ code: "E_ARCHIVE_INVALID_EXPIRY" }));
		});
	});

	describe("putStream / getStream", () => {
		beforeEach(() => {
			fetchSpy.mockResolvedValueOnce(tokenResponse());
		});

		it("putStream buffers the stream and issues a single POST upload", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.putStream(
				"streamed.bin",
				Readable.from(Buffer.from([0x00, 0xff, 0x01])),
				{ contentType: "application/octet-stream", contentLength: 3 },
			);
			const [url, init] = fetchSpy.mock.calls[1] ?? [];
			expect(String(url)).toContain("uploadType=media");
			expect(String(url)).toContain("name=streamed.bin");
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers["content-type"]).toBe("application/octet-stream");
		});

		it("getStream returns a Node Readable re-emitting the bytes", async () => {
			const payload = Buffer.from([0x01, 0x02, 0x03, 0xff]);
			fetchSpy.mockResolvedValueOnce(new Response(payload, { status: 200 }));
			const stream = await driver.getStream("cat.bin");
			const drained = await drainStream(stream);
			expect(drained.equals(payload)).toBe(true);
		});

		it("getStream on 404 throws E_ARCHIVE_NOT_FOUND", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			await expect(driver.getStream("missing")).rejects.toMatchObject({
				code: "E_ARCHIVE_NOT_FOUND",
			});
		});
	});

	describe("url (visibility branching)", () => {
		beforeEach(() => {
			fetchSpy.mockResolvedValueOnce(tokenResponse());
		});

		it("public file → direct URL", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						size: "5",
						contentType: "text/plain",
						updated: "2025-01-01T00:00:00Z",
						etag: '"e"',
						acl: [{ entity: "allUsers", role: "READER" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
			const url = await driver.url("cat.png");
			expect(url).toBe("https://storage.googleapis.com/my-bucket/cat.png");
		});

		it("private file → presigned URL with X-Goog-Signature", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						size: "5",
						contentType: "text/plain",
						updated: "2025-01-01T00:00:00Z",
						etag: '"e"',
						acl: [{ entity: "user-owner", role: "OWNER" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
			const url = await driver.url("cat.png");
			expect(url).toContain("X-Goog-Signature=");
			expect(url).toContain("X-Goog-Expires=300");
		});

		it("copy POSTs to /o/{from}/copyTo/b/{bucket}/o/{to} with Bearer auth", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.copy("src/a.txt", "dst/b.txt");
			const [url, init] = fetchSpy.mock.calls[1] ?? [];
			// The JSON API addresses one object as one path segment, so the
			// slashes inside the name are percent-encoded — left raw they
			// address a different resource, which answers 404.
			expect(String(url)).toContain(
				"/storage/v1/b/my-bucket/o/src%2Fa.txt/copyTo/b/my-bucket/o/dst%2Fb.txt",
			);
			expect((init as RequestInit).method).toBe("POST");
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers.authorization).toBe("Bearer test-token");
		});

		it("copy 404 → E_ARCHIVE_NOT_FOUND", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			await expect(driver.copy("none", "dst")).rejects.toMatchObject({
				code: "E_ARCHIVE_NOT_FOUND",
			});
		});

		it("list paginates via pageToken across two requests", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{ name: "cat/a.txt", size: "1", updated: "2025-01-01T00:00:00Z" },
							{ name: "cat/b.txt", size: "2", updated: "2025-01-02T00:00:00Z" },
						],
						nextPageToken: "page2",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{ name: "cat/c.txt", size: "3", updated: "2025-01-03T00:00:00Z" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
			const out: Array<{ path: string; size: number }> = [];
			for await (const entry of driver.list("cat/")) {
				out.push({ path: entry.path, size: entry.size });
			}
			expect(out).toEqual([
				{ path: "cat/a.txt", size: 1 },
				{ path: "cat/b.txt", size: 2 },
				{ path: "cat/c.txt", size: 3 },
			]);
			expect(String(fetchSpy.mock.calls[2]?.[0])).toContain("pageToken=page2");
		});

		it("publicUrl uses config.publicUrl when configured", () => {
			// Build a real driver (fresh RSA keypair) — publicUrl() is
			// pure-sync and doesn't touch the key, but the constructor
			// requires a valid PEM.
			const cdn = buildDriver();
			// Re-construct with publicUrl since buildDriver() doesn't set it.
			const { privateKey } = generateKeyPairSync("rsa", {
				modulusLength: 2048,
				publicKeyEncoding: { type: "spki", format: "pem" },
				privateKeyEncoding: { type: "pkcs8", format: "pem" },
			});
			const cdnWithRoot = new GcsDriver({
				bucket: "my-bucket",
				serviceAccount: {
					client_email: "x@x.iam.gserviceaccount.com",
					private_key: privateKey,
				},
				publicUrl: "https://cdn.example.com/assets",
			});
			expect(cdnWithRoot.publicUrl("folder/cat.png")).toBe(
				"https://cdn.example.com/assets/folder/cat.png",
			);
			// Sanity: without publicUrl, publicUrl() falls back to the API root.
			expect(cdn.publicUrl("folder/cat.png")).toBe(
				"https://storage.googleapis.com/my-bucket/folder/cat.png",
			);
		});
	});
});

describe("GcsDriver > listing, deleting a prefix, and the rest", () => {
	let driver: GcsDriver;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	const json = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

	beforeEach(() => {
		driver = buildDriver();
		fetchSpy = vi.spyOn(globalThis, "fetch");
		// Every call below needs a token first.
		fetchSpy.mockResolvedValueOnce(tokenResponse());
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	/** The request the driver made, skipping the token exchange. */
	const call = (n: number) =>
		fetchSpy.mock.calls[n + 1] as [string, RequestInit];

	it("yields the directories before the files, and drops the trailing slash", async () => {
		fetchSpy.mockResolvedValueOnce(
			json({
				prefixes: ["invoices/2026/"],
				items: [
					{
						name: "invoices/readme.txt",
						size: "12",
						updated: "2026-03-14T00:00:00.000Z",
						contentType: "text/plain",
						etag: '"abc"',
					},
				],
			}),
		);

		const objects = [...(await driver.listAll("invoices")).objects];

		expect(objects.map((o) => (o.isDirectory ? o.prefix : o.key))).toEqual([
			"invoices/2026",
			"invoices/readme.txt",
		]);
		const file = objects[1];
		if (!file.isFile) throw new Error("expected a file");
		expect(await file.getMetaData()).toMatchObject({
			size: 12,
			mimeType: "text/plain",
			etag: "abc",
		});
	});

	it("adds the delimiter and the trailing slash by default", async () => {
		fetchSpy.mockResolvedValueOnce(json({}));

		await driver.listAll("invoices");

		// Without the delimiter GCS returns every descendant, so a
		// non-recursive listing would silently become a recursive one.
		const url = String(call(0)[0]);
		expect(url).toContain("delimiter=%2F");
		expect(url).toContain("prefix=invoices%2F");
	});

	it("drops the delimiter when the caller asked to recurse", async () => {
		fetchSpy.mockResolvedValueOnce(json({}));

		await driver.listAll("invoices", { recursive: true });

		expect(String(call(0)[0])).not.toContain("delimiter");
	});

	it("reads the bucket root from an empty prefix and from a bare slash", async () => {
		fetchSpy.mockResolvedValueOnce(json({}));
		fetchSpy.mockResolvedValueOnce(json({}));

		await driver.listAll("");
		await driver.listAll("/");

		expect(String(call(0)[0])).toContain("prefix=&");
		expect(String(call(1)[0])).toContain("prefix=&");
	});

	it("carries the caller's page token, and hands the next one back", async () => {
		fetchSpy.mockResolvedValueOnce(json({ nextPageToken: "page3" }));

		const result = await driver.listAll("a", { paginationToken: "page2" });

		expect(String(call(0)[0])).toContain("pageToken=page2");
		expect(result.paginationToken).toBe("page3");
	});

	it("says so rather than returning an empty listing on a failure", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("denied", { status: 403 }));

		// An empty listing reads as "the prefix is empty", which is how a
		// deleteAll over it silently does nothing.
		await expect(driver.listAll("a")).rejects.toThrow(
			/GCS LIST failed \(403\)/,
		);
	});

	it("deletes every object under a prefix, one at a time", async () => {
		// GCS has no batch delete; the listing is drained first so the
		// deletes cannot disturb the pagination cursor.
		fetchSpy.mockResolvedValueOnce(
			json({ items: [{ name: "cat/a.txt" }, { name: "cat/b.txt" }] }),
		);
		fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

		await driver.deleteAll("cat/");

		expect(String(call(1)[0])).toContain("cat%2Fa.txt");
		expect(call(1)[1].method).toBe("DELETE");
		expect(String(call(2)[0])).toContain("cat%2Fb.txt");
	});

	it("issues no delete for an empty prefix", async () => {
		fetchSpy.mockResolvedValueOnce(json({ items: [] }));

		await driver.deleteAll("cat/");

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("move copies then deletes the source", async () => {
		fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

		await driver.move("a.txt", "b.txt");

		expect(call(0)[1].method).toBe("POST");
		expect(String(call(0)[0])).toContain("copyTo");
		expect(call(1)[1].method).toBe("DELETE");
	});

	it("leaves the source in place when the copy failed", async () => {
		// Deleting after a failed copy loses the object outright.
		fetchSpy.mockResolvedValueOnce(new Response("denied", { status: 403 }));

		await expect(driver.move("a.txt", "b.txt")).rejects.toThrow();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("getBytes returns the body as bytes, and says when it is missing", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("hello", { status: 200 }));
		expect(Buffer.from(await driver.getBytes("a.txt")).toString()).toBe(
			"hello",
		);

		fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
		await expect(driver.getBytes("a.txt")).rejects.toMatchObject({
			code: "E_ARCHIVE_NOT_FOUND",
		});
	});

	it("signs an upload URL that differs from the download one", () => {
		const upload = driver.getSignedUploadUrl("a.txt");
		const download = driver.getSignedUrl("a.txt");

		// The method is part of the signature: handing a GET-signed URL to
		// an uploader fails at the far end with a signature mismatch.
		expect(upload).toContain("X-Goog-Signature=");
		expect(upload).toContain("X-Goog-SignedHeaders=host");
		expect(upload).not.toBe(download);
	});

	it("honours a custom expiry on an upload URL, and refuses one out of range", () => {
		expect(driver.getSignedUploadUrl("a.txt", { expiresIn: 60 })).toContain(
			"X-Goog-Expires=60",
		);
		expect(() =>
			driver.getSignedUploadUrl("a.txt", { expiresIn: -1 }),
		).toThrow();
	});
});

describe("GcsDriver > a key inside a prefix", () => {
	let driver: GcsDriver;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		driver = buildDriver();
		fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(tokenResponse());
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	/** The last URL requested — the token exchange only happens once. */
	const requested = () => String(fetchSpy.mock.calls.at(-1)?.[0]);

	/**
	 * The JSON API addresses `…/b/{bucket}/o/{object}` where the whole object
	 * name is ONE path segment. A raw slash there addresses a different
	 * resource, which answers 404 — and since `exists()`/`delete()` read a 404
	 * as "not there", every object inside a prefix would look absent while
	 * reporting no error at all.
	 */
	it("percent-encodes the slashes on every JSON-API call", async () => {
		const cases: Array<[string, () => Promise<unknown>]> = [
			["get", () => driver.get("invoices/2026/a.pdf")],
			["getBytes", () => driver.getBytes("invoices/2026/a.pdf")],
			["getStream", () => driver.getStream("invoices/2026/a.pdf")],
			["delete", () => driver.delete("invoices/2026/a.pdf")],
			["exists", () => driver.exists("invoices/2026/a.pdf")],
			["getMetadata", () => driver.getMetadata("invoices/2026/a.pdf")],
			[
				"setVisibility",
				() => driver.setVisibility("invoices/2026/a.pdf", "public"),
			],
		];

		for (const [name, run] of cases) {
			fetchSpy.mockClear();
			fetchSpy.mockResolvedValueOnce(tokenResponse());
			fetchSpy.mockResolvedValue(
				new Response(JSON.stringify({ acl: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

			await run().catch(() => undefined);

			expect(requested(), name).toContain("invoices%2F2026%2Fa.pdf");
			expect(requested(), name).not.toContain("/o/invoices/2026/");
		}
	});

	it("leaves the slashes alone on the public URL", () => {
		// The download endpoint takes the name as a real path, and a `%2F` in
		// a public URL is what a CDN in front will not match.
		expect(driver.publicUrl("invoices/2026/a.pdf")).toBe(
			"https://storage.googleapis.com/my-bucket/invoices/2026/a.pdf",
		);
	});

	it("leaves the slashes alone in a signed URL", () => {
		// The V4 signing rules list the characters to percent-encode, and `/`
		// is not among them: encoding it would break every signature.
		const url = driver.getSignedUrl("invoices/2026/a.pdf");

		expect(url).toContain("/my-bucket/invoices/2026/a.pdf?");
		expect(url).toContain("X-Goog-Signature=");
	});

	it("still encodes the characters that are reserved everywhere", () => {
		expect(driver.publicUrl("a b&c.txt")).toContain("a%20b%26c.txt");
	});
});

describe("GcsDriver > visibility read through metadata", () => {
	it("reports the visibility the ACL implies", async () => {
		const driver = buildDriver();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(tokenResponse());
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					size: "5",
					updated: "2026-03-14T00:00:00.000Z",
					acl: [{ entity: "allUsers", role: "READER" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		expect(await driver.getVisibility("a.txt")).toBe("public");
		fetchSpy.mockRestore();
	});
});
