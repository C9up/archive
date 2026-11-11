import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSignedRouteHandler,
	DriveManager,
	LocalDriver,
	StaticMiddleware,
	StorageManager,
	services,
} from "../../src/index.js";
import type { StaticMiddlewareResponse } from "../../src/StaticMiddleware.js";
import type {
	SignedRouteHttpContext,
	SignedRouteResponse,
} from "../../src/signed-route.js";

/**
 * Minimal HttpContext stand-in. Matches the subset of the Ream
 * Request/Response surface that the signed-route handler calls.
 */
function buildCtx(
	method: string,
	fullPath: string,
	reqHeaders: Record<string, string> = {},
) {
	const [reqPath, qs = ""] = fullPath.split("?");
	const qsObject: Record<string, unknown> = {};
	for (const [k, v] of new URLSearchParams(qs)) qsObject[k] = v;
	const statusSpy = vi.fn<(code: number) => SignedRouteResponse>();
	const headerSpy =
		vi.fn<(name: string, value: string) => SignedRouteResponse>();
	// Drains what it is handed, as the framework's response does, so a test
	// can read the body that went out.
	const chunks: Buffer[] = [];
	const streamSpy = vi.fn<(body: NodeJS.ReadableStream) => Promise<void>>(
		async (body) => {
			for await (const chunk of body) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
		},
	);
	const jsonSpy = vi.fn<(data: unknown) => void>();
	const response: SignedRouteHttpContext["response"] = {
		status: statusSpy,
		header: headerSpy,
		stream: streamSpy,
		json: jsonSpy,
	};
	statusSpy.mockReturnValue(response);
	headerSpy.mockReturnValue(response);
	const request = {
		method: () => method,
		path: () => reqPath ?? "",
		qs: () => qsObject,
		header: (name: string) => reqHeaders[name.toLowerCase()],
	};
	const ctx: SignedRouteHttpContext = { request, response };
	return {
		ctx,
		body: () => Buffer.concat(chunks).toString(),
		response: {
			status: statusSpy,
			header: headerSpy,
			stream: streamSpy,
			json: jsonSpy,
		},
	};
}

describe("createSignedRouteHandler", () => {
	let root: string;
	let driver: LocalDriver;
	let storage: StorageManager;
	let middleware: ReturnType<typeof createSignedRouteHandler>;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-signed-"));
		driver = new LocalDriver(root, { signingSecret: "s3cr3t-s3cr3t-s3cr3t" });
		storage = new StorageManager(driver);
		middleware = createSignedRouteHandler({
			storage,
			driver,
			prefix: "/storage",
		});
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("serves the file when the signature is valid", async () => {
		await driver.put("cat.txt", "hello");
		const url = driver.getSignedUrl("cat.txt");
		const { ctx, response } = buildCtx("GET", url);
		const next = vi.fn(async () => {});
		await middleware(ctx, next);
		expect(next).not.toHaveBeenCalled();
		expect(response.status).toHaveBeenCalledWith(200);
		expect(response.stream).toHaveBeenCalledTimes(1);
		expect(response.header).toHaveBeenCalledWith("Content-Type", "text/plain");
	});

	it("returns 403 E_INVALID_SIGNATURE when a single char in sig is flipped", async () => {
		await driver.put("cat.txt", "hello");
		const url = driver.getSignedUrl("cat.txt");
		const tampered = url.replace(/&sig=([a-f0-9])/, (_, first) => {
			const next = first === "a" ? "b" : "a";
			return `&sig=${next}`;
		});
		const { ctx, response } = buildCtx("GET", tampered);
		await middleware(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(403);
		const call = response.json.mock.calls[0]?.[0] as {
			error: { code: string };
		};
		expect(call.error.code).toBe("E_INVALID_SIGNATURE");
	});

	it("returns 403 E_INVALID_SIGNATURE on a truncated signature (length mismatch)", async () => {
		await driver.put("cat.txt", "hello");
		const url = driver.getSignedUrl("cat.txt");
		const truncated = url.replace(/&sig=[a-f0-9]+$/, "&sig=abc");
		const { ctx, response } = buildCtx("GET", truncated);
		await middleware(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(403);
	});

	it("returns 403 E_EXPIRED_SIGNATURE when exp is in the past", async () => {
		await driver.put("cat.txt", "hello");
		// Build an expired URL by hand (exp in the past) — sign manually.
		const { createHmac } = await import("node:crypto");
		const exp = Math.floor(Date.now() / 1000) - 10;
		const sig = createHmac("sha256", "s3cr3t-s3cr3t-s3cr3t")
			.update(`cat.txt\n${exp}`)
			.digest("hex");
		const url = `/storage/cat.txt?exp=${exp}&sig=${sig}`;
		const { ctx, response } = buildCtx("GET", url);
		await middleware(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(403);
		const call = response.json.mock.calls[0]?.[0] as {
			error: { code: string };
		};
		expect(call.error.code).toBe("E_EXPIRED_SIGNATURE");
	});

	it("returns E_INVALID_SIGNATURE (not E_EXPIRED_SIGNATURE) when an invalid sig accompanies an expired exp", async () => {
		// HMAC verification must run BEFORE the expiry check so an
		// attacker cannot distinguish "valid sig, expired URL" from
		// "invalid sig, fresh URL" via response timing or error code.
		await driver.put("cat.txt", "hello");
		const exp = Math.floor(Date.now() / 1000) - 10;
		const garbageSig = "0".repeat(64);
		const url = `/storage/cat.txt?exp=${exp}&sig=${garbageSig}`;
		const { ctx, response } = buildCtx("GET", url);
		await middleware(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(403);
		const call = response.json.mock.calls[0]?.[0] as {
			error: { code: string };
		};
		expect(call.error.code).toBe("E_INVALID_SIGNATURE");
	});

	it("rejects exp with trailing garbage (parseInt would silently truncate)", async () => {
		// parseInt("1799999999xyz", 10) returns 1799999999, so the
		// HMAC would still match a sig signed for the canonical integer.
		// Strict numeric validation must reject the alias before we
		// reach HMAC verification.
		await driver.put("cat.txt", "hello");
		const validUrl = driver.getSignedUrl("cat.txt");
		const aliased = validUrl.replace(/exp=(\d+)/, "exp=$1xyz");
		const { ctx, response } = buildCtx("GET", aliased);
		await middleware(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(403);
		const call = response.json.mock.calls[0]?.[0] as {
			error: { code: string };
		};
		expect(call.error.code).toBe("E_INVALID_SIGNATURE");
	});

	it("falls through to next() for an unsigned request naming no stored file", async () => {
		const { ctx, response } = buildCtx("GET", "/storage/cat.txt");
		const next = vi.fn(async () => {});
		await middleware(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).not.toHaveBeenCalled();
	});

	it("refuses an unsigned request for a private file", async () => {
		await storage.put("secret.pdf", "top secret", { visibility: "private" });
		const { ctx, response } = buildCtx("GET", "/storage/secret.pdf");
		const next = vi.fn(async () => {});
		await middleware(ctx, next);
		// Not handed on: whatever is mounted behind (a static server over the
		// storage root) would serve it without looking at visibility.
		expect(next).not.toHaveBeenCalled();
		expect(response.status).toHaveBeenCalledWith(403);
		expect(response.json).toHaveBeenCalledWith({
			error: { code: "E_ARCHIVE_ACCESS_DENIED", message: "Access denied" },
		});
		expect(response.stream).not.toHaveBeenCalled();
	});

	it("refuses a request carrying half a signature for a private file", async () => {
		await storage.put("secret.pdf", "top secret", { visibility: "private" });
		const exp = Math.floor(Date.now() / 1000) + 60;
		for (const query of [`exp=${exp}`, `sig=${"0".repeat(64)}`]) {
			const { ctx, response } = buildCtx("GET", `/storage/secret.pdf?${query}`);
			const next = vi.fn(async () => {});
			await middleware(ctx, next);
			expect(next).not.toHaveBeenCalled();
			expect(response.status).toHaveBeenCalledWith(403);
			expect(response.stream).not.toHaveBeenCalled();
		}
	});

	it("answers a path the disk will not address with 403, not an exception", async () => {
		await storage.put("secret.pdf", "top secret", { visibility: "private" });
		for (const target of [
			"/storage/a/%2e%2e/secret.pdf",
			"/storage/a/../secret.pdf",
			"/storage/a%2fsecret.pdf",
			"/storage/secret.pdf.archive-visibility.json",
		]) {
			const { ctx, response } = buildCtx("GET", target);
			const next = vi.fn(async () => {});
			await middleware(ctx, next);
			expect(next, target).not.toHaveBeenCalled();
			expect(response.status, target).toHaveBeenCalledWith(403);
			expect(response.stream, target).not.toHaveBeenCalled();
		}
	});

	it("serves an unsigned request for a public file itself", async () => {
		await storage.put("cat.txt", "hello");
		const { ctx, response, body } = buildCtx("GET", "/storage/cat.txt");
		const next = vi.fn(async () => {});
		await middleware(ctx, next);
		expect(next).not.toHaveBeenCalled();
		expect(response.status).toHaveBeenCalledWith(200);
		expect(body()).toBe("hello");
	});

	it("does not let a static server mounted behind it serve a private file", async () => {
		await storage.put("secret.pdf", "top secret", { visibility: "private" });
		const statics = new StaticMiddleware({
			root,
			prefix: "/storage",
			extensions: [".pdf"],
		});
		const { ctx, response } = buildCtx("GET", "/storage/secret.pdf");
		const staticSend = vi.fn<(buf: Buffer) => void>();
		const staticResponse: StaticMiddlewareResponse = {
			status: () => staticResponse,
			header: () => staticResponse,
			sendBuffer: staticSend,
		};
		await middleware(ctx, () =>
			statics.handle(
				{ request: ctx.request, response: staticResponse },
				async () => {},
			),
		);
		expect(response.stream).not.toHaveBeenCalled();
		expect(staticSend).not.toHaveBeenCalled();
		expect(response.status).toHaveBeenCalledWith(403);
	});

	it("rejects a sig matching a different file path", async () => {
		await driver.put("cat.txt", "hello");
		await driver.put("dog.txt", "world");
		const cat = driver.getSignedUrl("cat.txt");
		// Swap the file path in the URL but keep the cat signature.
		const swapped = cat.replace("/storage/cat.txt", "/storage/dog.txt");
		const { ctx, response } = buildCtx("GET", swapped);
		await middleware(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(403);
	});

	it("returns 404 E_NOT_FOUND when the signature is valid but the file is missing", async () => {
		const url = driver.getSignedUrl("missing.txt");
		const { ctx, response } = buildCtx("GET", url);
		await middleware(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(404);
	});

	it("falls through to next() for non-GET methods", async () => {
		const url = driver.getSignedUrl("anything.txt");
		const { ctx } = buildCtx("POST", url);
		const next = vi.fn(async () => {});
		await middleware(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("falls through to next() when the prefix does not match", async () => {
		const url = driver
			.getSignedUrl("cat.txt")
			.replace("/storage/", "/elsewhere/");
		const { ctx } = buildCtx("GET", url);
		const next = vi.fn(async () => {});
		await middleware(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("serves the URLs a driver signs under its own route base path", async () => {
		const filesDriver = new LocalDriver(root, {
			signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			routeBasePath: "/files/",
		});
		await filesDriver.put("cat.txt", "hello");
		expect(filesDriver.getRouteBasePath()).toBe("/files");
		expect(filesDriver.publicUrl("cat.txt")).toBe("/files/cat.txt");
		const url = filesDriver.getSignedUrl("cat.txt");
		expect(url.startsWith("/files/cat.txt?exp=")).toBe(true);

		// One value drives both: the route takes the driver's prefix.
		const handler = createSignedRouteHandler({
			storage: new StorageManager(filesDriver),
			driver: filesDriver,
		});
		const { ctx, response } = buildCtx("GET", url);
		const next = vi.fn(async () => {});
		await handler(ctx, next);
		expect(next).not.toHaveBeenCalled();
		expect(response.status).toHaveBeenCalledWith(200);
	});

	it("takes the route base path from the disk config", () => {
		const drive = new DriveManager({
			default: "files",
			services: {
				files: services.fs({ location: root, routeBasePath: "/files" }),
			},
		});
		expect(drive.use().publicUrl("a.txt")).toBe("/files/a.txt");
	});

	it("refuses a route prefix the driver does not sign under", () => {
		const filesDriver = new LocalDriver(root, {
			signingSecret: "s3cr3t-s3cr3t-s3cr3t",
			routeBasePath: "/files",
		});
		expect(() =>
			createSignedRouteHandler({
				storage: new StorageManager(filesDriver),
				driver: filesDriver,
				prefix: "/storage",
			}),
		).toThrow(expect.objectContaining({ code: "E_ARCHIVE_PREFIX_MISMATCH" }));
	});

	it("refuses a route base path that is not an absolute URL path", () => {
		for (const routeBasePath of [
			"",
			"/",
			"files",
			"/files?x=1",
			"/a#b",
			"/a b",
		]) {
			expect(
				() => new LocalDriver(root, { routeBasePath }),
				routeBasePath,
			).toThrow(
				expect.objectContaining({ code: "E_ARCHIVE_INVALID_ROUTE_BASE_PATH" }),
			);
		}
	});

	it("throws at construction time if the driver has no signing secret", () => {
		const noSignDriver = new LocalDriver(root);
		expect(() =>
			createSignedRouteHandler({
				storage: new StorageManager(noSignDriver),
				driver: noSignDriver,
			}),
		).toThrow(/signingSecret/);
	});
});

describe("createSignedRouteHandler > response header overrides", () => {
	let root: string;
	let driver: LocalDriver;
	let middleware: ReturnType<typeof createSignedRouteHandler>;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-signed-headers-"));
		driver = new LocalDriver(root, { signingSecret: "s3cr3t-s3cr3t-s3cr3t" });
		middleware = createSignedRouteHandler({
			storage: new StorageManager(driver),
			driver,
		});
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const disposition = 'attachment; filename="x.pdf"';

	it("signs the overrides and serves them", async () => {
		await driver.put("report.pdf", "%PDF");
		const url = driver.getSignedUrl("report.pdf", {
			contentType: "application/x-report",
			contentDisposition: disposition,
		});
		const { ctx, response } = buildCtx("GET", url);
		await middleware(
			ctx,
			vi.fn(async () => {}),
		);
		expect(response.status).toHaveBeenCalledWith(200);
		expect(response.header).toHaveBeenCalledWith(
			"Content-Type",
			"application/x-report",
		);
		expect(response.header).toHaveBeenCalledWith(
			"Content-Disposition",
			disposition,
		);
	});

	it("refuses an override the signature does not cover", async () => {
		await driver.put("report.pdf", "%PDF");
		const plain = driver.getSignedUrl("report.pdf");
		const signed = driver.getSignedUrl("report.pdf", {
			contentDisposition: disposition,
		});
		for (const forged of [
			// Added to a URL signed without it.
			`${plain}&contentDisposition=${encodeURIComponent("inline")}`,
			// Changed after signing.
			signed.replace(
				/contentDisposition=[^&]*/,
				`contentDisposition=${encodeURIComponent("inline")}`,
			),
			// Dropped after signing.
			signed.replace(/&contentDisposition=[^&]*/, ""),
		]) {
			const { ctx, response } = buildCtx("GET", forged);
			await middleware(
				ctx,
				vi.fn(async () => {}),
			);
			expect(response.status, forged).toHaveBeenCalledWith(403);
			expect(response.stream, forged).not.toHaveBeenCalled();
		}
	});

	it("refuses to sign a header value that could split the response", () => {
		expect(() =>
			driver.getSignedUrl("report.pdf", {
				contentDisposition: "inline\r\nSet-Cookie: a=b",
			}),
		).toThrow(
			expect.objectContaining({ code: "E_ARCHIVE_INVALID_HEADER_VALUE" }),
		);
	});
});

describe("createSignedRouteHandler > streaming and revalidation", () => {
	let root: string;
	let driver: LocalDriver;
	let storage: StorageManager;
	let middleware: ReturnType<typeof createSignedRouteHandler>;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-signed-stream-"));
		driver = new LocalDriver(root, { signingSecret: "s3cr3t-s3cr3t-s3cr3t" });
		storage = new StorageManager(driver);
		middleware = createSignedRouteHandler({ storage, driver });
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("streams the file instead of reading it into memory", async () => {
		await storage.put("big.bin", Buffer.alloc(256 * 1024, 7), {
			visibility: "private",
		});
		const getSpy = vi.spyOn(storage, "get");
		const { ctx, response, body } = buildCtx(
			"GET",
			driver.getSignedUrl("big.bin"),
		);
		await middleware(
			ctx,
			vi.fn(async () => {}),
		);
		expect(getSpy).not.toHaveBeenCalled();
		expect(response.stream).toHaveBeenCalledTimes(1);
		expect(body().length).toBe(256 * 1024);
		expect(response.header).toHaveBeenCalledWith(
			"Content-Length",
			String(256 * 1024),
		);
	});

	it("sends a validator and answers 304 to a client that already has the file", async () => {
		await storage.put("cat.txt", "hello", { visibility: "private" });
		const url = driver.getSignedUrl("cat.txt");
		const first = buildCtx("GET", url);
		await middleware(
			first.ctx,
			vi.fn(async () => {}),
		);
		const etag = first.response.header.mock.calls.find(
			([name]) => name === "ETag",
		)?.[1];
		expect(etag).toBe((await storage.getMetadata("cat.txt")).etag);
		expect(
			first.response.header.mock.calls.some(([n]) => n === "Last-Modified"),
		).toBe(true);

		for (const method of ["GET", "HEAD"]) {
			const again = buildCtx(method, url, { "if-none-match": etag ?? "" });
			await middleware(
				again.ctx,
				vi.fn(async () => {}),
			);
			expect(again.response.status, method).toHaveBeenCalledWith(304);
			expect(again.response.stream, method).not.toHaveBeenCalled();
		}

		// A stale validator gets the file.
		const stale = buildCtx("GET", url, { "if-none-match": 'W/"stale"' });
		await middleware(
			stale.ctx,
			vi.fn(async () => {}),
		);
		expect(stale.response.status).toHaveBeenCalledWith(200);
		expect(stale.body()).toBe("hello");
	});
});
