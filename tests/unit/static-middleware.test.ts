import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticMiddleware } from "../../src/index.js";
import type {
	StaticMiddlewareHttpContext,
	StaticMiddlewareResponse,
} from "../../src/StaticMiddleware.js";

/**
 * Build a plain-object HttpContext that satisfies the
 * StaticMiddlewareHttpContext structural interface. No double-cast —
 * the handler accepts the structural type directly.
 */
function makeCtx(
	method: string,
	reqPath: string,
	reqHeaders: Record<string, string> = {},
) {
	const statusSpy = vi.fn<(code: number) => StaticMiddlewareResponse>();
	const headerSpy =
		vi.fn<(name: string, value: string) => StaticMiddlewareResponse>();
	const sendBufferSpy = vi.fn<(buf: Buffer) => void>();
	const response: StaticMiddlewareResponse = {
		status: statusSpy,
		header: headerSpy,
		sendBuffer: sendBufferSpy,
	};
	// Fluent chain: status()/header() return the response itself.
	statusSpy.mockReturnValue(response);
	headerSpy.mockReturnValue(response);

	const request = {
		method: () => method,
		path: () => reqPath,
		header: (name: string) => reqHeaders[name.toLowerCase()],
	};
	const ctx: StaticMiddlewareHttpContext = { request, response };
	return {
		ctx,
		response: {
			status: statusSpy,
			header: headerSpy,
			sendBuffer: sendBufferSpy,
		},
	};
}

describe("StaticMiddleware", () => {
	let root: string;
	let middleware: StaticMiddleware;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-static-"));
		middleware = new StaticMiddleware({ root, prefix: "/static" });
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("serves an existing file with content-type, ETag, and cache-control", async () => {
		fs.writeFileSync(path.join(root, "hello.txt"), "hi");
		const { ctx, response } = makeCtx("GET", "/static/hello.txt");
		const next = vi.fn<() => Promise<void>>(async () => {});

		await middleware.handle(ctx, next);

		expect(next).not.toHaveBeenCalled();
		expect(response.header).toHaveBeenCalledWith("Content-Type", "text/plain");
		expect(response.header).toHaveBeenCalledWith(
			"Cache-Control",
			expect.stringMatching(/^public, max-age=/),
		);
		expect(
			response.header.mock.calls.some((call: unknown[]) => call[0] === "ETag"),
		).toBe(true);
		expect(response.status).toHaveBeenCalledWith(200);
		expect(response.sendBuffer).toHaveBeenCalledTimes(1);
	});

	it("falls through to next() when the file is missing", async () => {
		const { ctx, response } = makeCtx("GET", "/static/never.txt");
		const next = vi.fn<() => Promise<void>>(async () => {});

		await middleware.handle(ctx, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(response.sendBuffer).not.toHaveBeenCalled();
	});

	it("returns 304 when If-None-Match matches the current ETag", async () => {
		fs.writeFileSync(path.join(root, "a.css"), "body{}");
		// First request captures the ETag by spying on the header calls.
		const first = makeCtx("GET", "/static/a.css");
		await middleware.handle(first.ctx, vi.fn());
		const etagCall = first.response.header.mock.calls.find(
			(call: unknown[]) => call[0] === "ETag",
		);
		const etag = etagCall?.[1];
		expect(etag).toBeDefined();

		// Second request with matching If-None-Match.
		const { ctx, response } = makeCtx("GET", "/static/a.css", {
			"if-none-match": etag ?? "",
		});
		await middleware.handle(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(304);
		expect(response.sendBuffer).not.toHaveBeenCalled();
	});

	it("falls through when the URL prefix does not match (prefix-sibling safety)", async () => {
		const { ctx, response } = makeCtx("GET", "/staticx/evil.css");
		const next = vi.fn<() => Promise<void>>(async () => {});
		await middleware.handle(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).not.toHaveBeenCalled();
	});

	it("falls through on non-GET methods (e.g. POST)", async () => {
		fs.writeFileSync(path.join(root, "a.txt"), "x");
		const { ctx } = makeCtx("POST", "/static/a.txt");
		const next = vi.fn<() => Promise<void>>(async () => {});
		await middleware.handle(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("blocks path traversal even when the extension is allowed", async () => {
		// Write a file outside root to make sure we do NOT serve it.
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "archive-static-outside-"),
		);
		fs.writeFileSync(path.join(outside, "secret.txt"), "pwned");
		const relative = path.relative(root, path.join(outside, "secret.txt"));

		const { ctx, response } = makeCtx("GET", `/static/${relative}`);
		const next = vi.fn<() => Promise<void>>(async () => {});
		await middleware.handle(ctx, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(response.sendBuffer).not.toHaveBeenCalled();

		fs.rmSync(outside, { recursive: true, force: true });
	});

	it("falls through on disallowed extensions", async () => {
		fs.writeFileSync(path.join(root, "secret.env"), "SECRET=1");
		const { ctx, response } = makeCtx("GET", "/static/secret.env");
		const next = vi.fn<() => Promise<void>>(async () => {});
		await middleware.handle(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.sendBuffer).not.toHaveBeenCalled();
	});

	it("never serves .archive-visibility.json sidecar files, even if they exist", async () => {
		// Sidecar is an implementation detail of LocalDriver — exposing
		// it via static would leak visibility state for a file.
		fs.writeFileSync(
			path.join(root, "cat.txt.archive-visibility.json"),
			JSON.stringify({ visibility: "private" }),
		);
		const { ctx, response } = makeCtx(
			"GET",
			"/static/cat.txt.archive-visibility.json",
		);
		const next = vi.fn<() => Promise<void>>(async () => {});
		await middleware.handle(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.sendBuffer).not.toHaveBeenCalled();
	});
});
