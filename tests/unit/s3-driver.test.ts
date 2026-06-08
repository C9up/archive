import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Driver } from "../../src/index.js";

async function drainStream(readable: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of readable) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}
	return Buffer.concat(chunks);
}

describe("S3Driver", () => {
	let driver: S3Driver;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		driver = new S3Driver({
			bucket: "my-bucket",
			region: "us-east-1",
			accessKeyId: "AKIATEST",
			secretAccessKey: "secret",
		});
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("put sends a PUT with SigV4 Authorization header", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
		await driver.put("photos/cat.jpg", Buffer.from("jpeg-bytes"));

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] ?? [];
		expect(String(url)).toContain("/my-bucket/photos/cat.jpg");
		expect((init as RequestInit).method).toBe("PUT");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIATEST\//,
		);
		expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
		expect(headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
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

	it("delete returns true on 204", async () => {
		fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
		expect(await driver.delete("gone.txt")).toBe(true);
	});

	it("exists returns false when HEAD fails", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
		expect(await driver.exists("nope")).toBe(false);
	});

	it("publicUrl uses config.publicUrl when configured", () => {
		const d = new S3Driver({
			bucket: "b",
			region: "us-east-1",
			accessKeyId: "k",
			secretAccessKey: "s",
			publicUrl: "https://cdn.example.com/assets",
		});
		expect(d.publicUrl("x/y.png")).toBe(
			"https://cdn.example.com/assets/x/y.png",
		);
	});

	it("publicUrl encodes special characters in object keys", () => {
		expect(driver.publicUrl("folder name/hello world.jpg")).toContain(
			"folder%20name/hello%20world.jpg",
		);
	});

	it("throws on non-2xx PUT response", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response("access denied", { status: 403 }),
		);
		await expect(driver.put("x", Buffer.from("y"))).rejects.toThrow(
			/S3 PUT failed/i,
		);
	});

	describe("getSignedUrl (presigned)", () => {
		it("returns a URL with the required SigV4 query parameters", () => {
			const url = driver.getSignedUrl("photos/cat.jpg");
			const parsed = new URL(url);
			expect(parsed.pathname).toBe("/my-bucket/photos/cat.jpg");
			expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe(
				"AWS4-HMAC-SHA256",
			);
			expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
			expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
			expect(parsed.searchParams.get("X-Amz-Credential")).toMatch(
				/^AKIATEST\/\d{8}\/us-east-1\/s3\/aws4_request$/,
			);
			expect(parsed.searchParams.get("X-Amz-Date")).toMatch(/^\d{8}T\d{6}Z$/);
			expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
				/^[a-f0-9]{64}$/,
			);
		});

		it("honours a custom expiresIn", () => {
			const url = driver.getSignedUrl("file", { expiresIn: 60 });
			expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
		});

		it.each([
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			604_801,
		])("rejects out-of-range expiresIn (%s)", (bad) => {
			expect(() =>
				driver.getSignedUrl("file", { expiresIn: bad as number }),
			).toThrow(expect.objectContaining({ code: "ARCHIVE_INVALID_EXPIRY" }));
		});

		it("encodes special characters in the path", () => {
			const url = driver.getSignedUrl("folder name/hello world.jpg");
			expect(new URL(url).pathname).toContain(
				"folder%20name/hello%20world.jpg",
			);
		});
	});

	describe("metadata + visibility", () => {
		const publicAclXml = `<?xml version="1.0" encoding="UTF-8"?>
<AccessControlPolicy>
  <Owner><ID>owner</ID></Owner>
  <AccessControlList>
    <Grant>
      <Grantee xsi:type="Group" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <URI>http://acs.amazonaws.com/groups/global/AllUsers</URI>
      </Grantee>
      <Permission>READ</Permission>
    </Grant>
  </AccessControlList>
</AccessControlPolicy>`;
		const privateAclXml = `<?xml version="1.0" encoding="UTF-8"?>
<AccessControlPolicy>
  <Owner><ID>owner</ID></Owner>
  <AccessControlList>
    <Grant>
      <Grantee xsi:type="CanonicalUser" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <ID>owner</ID>
      </Grantee>
      <Permission>FULL_CONTROL</Permission>
    </Grant>
  </AccessControlList>
</AccessControlPolicy>`;

		function mockHeadAndAcl(acl: string) {
			fetchSpy.mockResolvedValueOnce(
				new Response("", {
					status: 200,
					headers: {
						"content-length": "1234",
						"content-type": "image/png",
						"last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
						etag: '"abc123"',
					},
				}),
			);
			fetchSpy.mockResolvedValueOnce(new Response(acl, { status: 200 }));
		}

		it("getMetadata returns parsed HEAD headers + public visibility when ACL grants AllUsers READ", async () => {
			mockHeadAndAcl(publicAclXml);
			const meta = await driver.getMetadata("cat.png");
			expect(meta.size).toBe(1234);
			expect(meta.mimeType).toBe("image/png");
			expect(meta.lastModified).toEqual(
				new Date("Wed, 21 Oct 2015 07:28:00 GMT"),
			);
			expect(meta.etag).toBe("abc123");
			expect(meta.visibility).toBe("public");
		});

		it("getMetadata returns private visibility when ACL has no AllUsers READ grant", async () => {
			mockHeadAndAcl(privateAclXml);
			const meta = await driver.getMetadata("cat.png");
			expect(meta.visibility).toBe("private");
		});

		it("getMetadata on 404 HEAD throws ARCHIVE_NOT_FOUND", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			await expect(driver.getMetadata("missing")).rejects.toMatchObject({
				code: "ARCHIVE_NOT_FOUND",
			});
		});

		it("getMetadata on non-2xx ACL falls back to private", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response("", {
					status: 200,
					headers: {
						"content-length": "10",
						"content-type": "text/plain",
						"last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
						etag: '"xyz"',
					},
				}),
			);
			fetchSpy.mockResolvedValueOnce(new Response("denied", { status: 403 }));
			const meta = await driver.getMetadata("x");
			expect(meta.visibility).toBe("private");
		});

		it("setVisibility('public') PUTs ?acl with x-amz-acl: public-read", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.setVisibility("cat.png", "public");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const [url, init] = fetchSpy.mock.calls[0] ?? [];
			expect(String(url)).toContain("/my-bucket/cat.png?acl");
			expect((init as RequestInit).method).toBe("PUT");
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers["x-amz-acl"]).toBe("public-read");
			expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
		});

		it("setVisibility('private') PUTs ?acl with x-amz-acl: private", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.setVisibility("cat.png", "private");
			const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)
				.headers as Record<string, string>;
			expect(headers["x-amz-acl"]).toBe("private");
		});

		it("setVisibility throws on non-2xx", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("denied", { status: 403 }));
			await expect(driver.setVisibility("x", "private")).rejects.toThrow(
				/S3 PUT failed/,
			);
		});

		it("url on a public file returns the direct URL", async () => {
			mockHeadAndAcl(publicAclXml);
			const url = await driver.url("cat.png");
			expect(url).toContain("/my-bucket/cat.png");
			expect(url).not.toContain("X-Amz-Signature");
		});

		it("url on a public file with config.publicUrl returns the CDN URL", async () => {
			const cdnDriver = new S3Driver({
				bucket: "my-bucket",
				region: "us-east-1",
				accessKeyId: "AKIATEST",
				secretAccessKey: "secret",
				publicUrl: "https://cdn.example.com/assets",
			});
			mockHeadAndAcl(publicAclXml);
			const url = await cdnDriver.url("cat.png");
			expect(url).toBe("https://cdn.example.com/assets/cat.png");
		});

		it("url on a private file returns a presigned URL", async () => {
			mockHeadAndAcl(privateAclXml);
			const url = await driver.url("cat.png");
			expect(url).toContain("X-Amz-Signature=");
			expect(url).toContain("X-Amz-Expires=300");
		});
	});

	describe("putStream / getStream", () => {
		it("single-PUT path when contentLength is known and <= 5 MiB", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			const body = Buffer.from("small upload");
			await driver.putStream("small.txt", Readable.from(body), {
				contentType: "text/plain",
				contentLength: body.length,
			});
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const [url, init] = fetchSpy.mock.calls[0] ?? [];
			expect(String(url)).toContain("/my-bucket/small.txt");
			expect((init as RequestInit).method).toBe("PUT");
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers["content-type"]).toBe("text/plain");
			expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
		});

		it("multipart path when contentLength > 5 MiB: initiate → upload-part(s) → complete", async () => {
			// 7 MiB forces one full 5 MiB part + one 2 MiB part.
			const partA = Buffer.alloc(5 * 1024 * 1024, 0x41);
			const partB = Buffer.alloc(2 * 1024 * 1024, 0x42);
			const body = Buffer.concat([partA, partB]);
			// Mock: 1) initiate 2) uploadPart 1 3) uploadPart 2 4) complete
			fetchSpy.mockResolvedValueOnce(
				new Response(
					`<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult>
  <UploadId>test-upload-id</UploadId>
</InitiateMultipartUploadResult>`,
					{ status: 200 },
				),
			);
			fetchSpy.mockResolvedValueOnce(
				new Response("", { status: 200, headers: { etag: '"etag-1"' } }),
			);
			fetchSpy.mockResolvedValueOnce(
				new Response("", { status: 200, headers: { etag: '"etag-2"' } }),
			);
			fetchSpy.mockResolvedValueOnce(
				new Response(
					`<?xml version="1.0"?><CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>`,
					{ status: 200 },
				),
			);

			await driver.putStream("big.bin", Readable.from(body), {
				contentType: "application/octet-stream",
				contentLength: body.length,
			});

			expect(fetchSpy).toHaveBeenCalledTimes(4);
			// Call 1: POST ?uploads
			expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
				"/my-bucket/big.bin?uploads",
			);
			// Call 2: PUT partNumber=1
			expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("partNumber=1");
			expect(String(fetchSpy.mock.calls[1]?.[0])).toContain(
				"uploadId=test-upload-id",
			);
			// Call 3: PUT partNumber=2
			expect(String(fetchSpy.mock.calls[2]?.[0])).toContain("partNumber=2");
			// Call 4: POST ?uploadId=… with the Complete XML
			const completeCall = fetchSpy.mock.calls[3];
			expect(String(completeCall?.[0])).toContain("uploadId=test-upload-id");
			const completeBody = (completeCall?.[1] as RequestInit).body as Buffer;
			expect(completeBody.toString("utf8")).toContain(
				'<PartNumber>1</PartNumber><ETag>"etag-1"</ETag>',
			);
			expect(completeBody.toString("utf8")).toContain(
				'<PartNumber>2</PartNumber><ETag>"etag-2"</ETag>',
			);
		});

		it("multipart path when contentLength is undefined, even for tiny streams", async () => {
			const body = Buffer.from("tiny");
			fetchSpy.mockResolvedValueOnce(
				new Response(
					`<InitiateMultipartUploadResult><UploadId>uid</UploadId></InitiateMultipartUploadResult>`,
					{ status: 200 },
				),
			);
			fetchSpy.mockResolvedValueOnce(
				new Response("", { status: 200, headers: { etag: '"e1"' } }),
			);
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.putStream("noLen.txt", Readable.from(body));
			// 3 calls = multipart path (initiate/part/complete), not single PUT.
			expect(fetchSpy).toHaveBeenCalledTimes(3);
			expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("?uploads");
		});

		it("multipart abort: DELETE ?uploadId on uploadPart failure, re-throws original error", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(
					`<InitiateMultipartUploadResult><UploadId>abortMe</UploadId></InitiateMultipartUploadResult>`,
					{ status: 200 },
				),
			);
			fetchSpy.mockResolvedValueOnce(new Response("denied", { status: 403 }));
			// Abort request should be issued after the failure.
			fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

			await expect(
				driver.putStream("boom.bin", Readable.from(Buffer.alloc(100))),
			).rejects.toThrow(/UploadPart failed/);
			// Call 3 should be the abort (DELETE ?uploadId=abortMe).
			const abortCall = fetchSpy.mock.calls[2];
			expect((abortCall?.[1] as RequestInit).method).toBe("DELETE");
			expect(String(abortCall?.[0])).toContain("uploadId=abortMe");
		});

		it("getStream returns a Node Readable that re-emits the response body bytes", async () => {
			const payload = Buffer.from([0x01, 0x02, 0x03, 0xff]);
			fetchSpy.mockResolvedValueOnce(new Response(payload, { status: 200 }));
			const stream = await driver.getStream("cat.bin");
			const drained = await drainStream(stream);
			expect(drained.equals(payload)).toBe(true);
		});

		it("getStream on 404 throws ARCHIVE_NOT_FOUND", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
			await expect(driver.getStream("missing")).rejects.toMatchObject({
				code: "ARCHIVE_NOT_FOUND",
			});
		});

		it("empty stream bypasses multipart entirely (single zero-byte PUT)", async () => {
			// Strict S3-compatible servers reject a multipart upload whose
			// only part is 0 bytes — the flow must fall through to a
			// direct single-PUT on empty streams.
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			const empty = Readable.from(Buffer.alloc(0));
			await driver.putStream("empty.bin", empty);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const [url, init] = fetchSpy.mock.calls[0] ?? [];
			expect(String(url)).toContain("/my-bucket/empty.bin");
			expect((init as RequestInit).method).toBe("PUT");
			// No ?uploads subresource — confirms we took the single-PUT path.
			expect(String(url)).not.toContain("?uploads");
			expect(String(url)).not.toContain("partNumber");
		});
	});

	describe("copy / move / list", () => {
		it("copy issues PUT with signed x-amz-copy-source header", async () => {
			fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));
			await driver.copy("src/a.txt", "dst/b.txt");
			const [url, init] = fetchSpy.mock.calls[0] ?? [];
			expect(String(url)).toContain("/my-bucket/dst/b.txt");
			expect((init as RequestInit).method).toBe("PUT");
			const headers = (init as RequestInit).headers as Record<string, string>;
			expect(headers["x-amz-copy-source"]).toBe("/my-bucket/src/a.txt");
			expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
		});

		it("copy throws ARCHIVE_NOT_FOUND when the source is reported as NoSuchKey", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response("<Error><Code>NoSuchKey</Code></Error>", {
					status: 404,
				}),
			);
			await expect(driver.copy("nope", "dst")).rejects.toMatchObject({
				code: "ARCHIVE_NOT_FOUND",
			});
		});

		it("list paginates via continuation-token across two requests", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(
					`<?xml version="1.0"?>
<ListBucketResult>
  <Contents><Key>cat/a.txt</Key><LastModified>2025-01-01T00:00:00.000Z</LastModified><Size>1</Size></Contents>
  <Contents><Key>cat/b.txt</Key><LastModified>2025-01-02T00:00:00.000Z</LastModified><Size>2</Size></Contents>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>page2</NextContinuationToken>
</ListBucketResult>`,
					{ status: 200 },
				),
			);
			fetchSpy.mockResolvedValueOnce(
				new Response(
					`<?xml version="1.0"?>
<ListBucketResult>
  <Contents><Key>cat/c.txt</Key><LastModified>2025-01-03T00:00:00.000Z</LastModified><Size>3</Size></Contents>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`,
					{ status: 200 },
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
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(String(fetchSpy.mock.calls[1]?.[0])).toContain(
				"continuation-token=page2",
			);
		});
	});
});
