import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSignedRouteHandler,
	LocalDriver,
	StorageManager,
} from "../../src/index.js";
import type {
	SignedRouteHttpContext,
	SignedRouteResponse,
} from "../../src/signed-route.js";

/**
 * Minimal HttpContext stand-in. Matches the subset of the Ream
 * Request/Response surface that the signed-route handler calls.
 */
function buildCtx(method: string, fullPath: string) {
	const [reqPath, qs = ""] = fullPath.split("?");
	const qsObject: Record<string, unknown> = {};
	for (const [k, v] of new URLSearchParams(qs)) qsObject[k] = v;
	const statusSpy = vi.fn<(code: number) => SignedRouteResponse>();
	const headerSpy =
		vi.fn<(name: string, value: string) => SignedRouteResponse>();
	const sendBufferSpy = vi.fn<(buf: Buffer) => void>();
	const jsonSpy = vi.fn<(data: unknown) => void>();
	const response: SignedRouteHttpContext["response"] = {
		status: statusSpy,
		header: headerSpy,
		sendBuffer: sendBufferSpy,
		json: jsonSpy,
	};
	statusSpy.mockReturnValue(response);
	headerSpy.mockReturnValue(response);
	const request = {
		method: () => method,
		path: () => reqPath ?? "",
		qs: () => qsObject,
		header: () => undefined,
	};
	const ctx: SignedRouteHttpContext = { request, response };
	return {
		ctx,
		response: {
			status: statusSpy,
			header: headerSpy,
			sendBuffer: sendBufferSpy,
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
		expect(response.sendBuffer).toHaveBeenCalledTimes(1);
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

	it("falls through to next() when exp or sig are missing (unsigned passthrough)", async () => {
		const { ctx, response } = buildCtx("GET", "/storage/cat.txt");
		const next = vi.fn(async () => {});
		await middleware(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).not.toHaveBeenCalled();
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
