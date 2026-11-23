import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
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
	// The body each `stream()` call carried, drained as a client would.
	const bodies: Buffer[] = [];
	const streamSpy = vi.fn<(body: NodeJS.ReadableStream) => Promise<void>>(
		async (body) => {
			const chunks: Buffer[] = [];
			for await (const chunk of body) {
				chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			}
			bodies.push(Buffer.concat(chunks));
		},
	);
	const response: StaticMiddlewareResponse = {
		status: statusSpy,
		header: headerSpy,
		stream: streamSpy,
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
		bodies,
		response: {
			status: statusSpy,
			header: headerSpy,
			stream: streamSpy,
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

	it("refuses an empty prefix", () => {
		expect(() => new StaticMiddleware({ root, prefix: "" })).toThrow(
			expect.objectContaining({ code: "E_ARCHIVE_INVALID_STATIC_PREFIX" }),
		);
	});

	it("does not serve a symlink pointing outside the root", async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "archive-secret-"));
		try {
			fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
			fs.symlinkSync(
				path.join(outside, "secret.txt"),
				path.join(root, "public.txt"),
			);
			const { ctx, response } = makeCtx("GET", "/static/public.txt");
			const next = vi.fn<() => Promise<void>>(async () => {});

			await middleware.handle(ctx, next);

			// The request falls through rather than sending what the link points
			// at — and the read now refuses to follow a link at open time, so a
			// link swapped in after the check cannot be served either.
			expect(next).toHaveBeenCalled();
			expect(response.stream).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
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
		expect(response.stream).toHaveBeenCalledTimes(1);
	});

	it("streams a file in bounded chunks instead of reading it whole", async () => {
		// A buffered read held one full copy of the file per request until the
		// response flushed: 20 concurrent requests for a 500 MB video held 10 GB,
		// and a file past Node's 2 GiB read cap was never served at all.
		const content = Buffer.alloc(1024 * 1024 + 7, 0x61);
		fs.writeFileSync(path.join(root, "video.mp4"), content);
		const probe = await fs.promises.open(path.join(root, "video.mp4"));
		const fileHandle: FileHandle = Object.getPrototypeOf(probe);
		await probe.close();
		const readWhole = vi.spyOn(fileHandle, "readFile");

		const chunkSizes: number[] = [];
		const received: Buffer[] = [];
		const response: StaticMiddlewareResponse = {
			status: () => response,
			header: () => response,
			stream: async (body) => {
				for await (const chunk of body) {
					const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
					chunkSizes.push(bytes.length);
					received.push(bytes);
				}
			},
		};
		const request = {
			method: () => "GET",
			path: () => "/static/video.mp4",
			header: () => undefined,
		};
		const next = vi.fn<() => Promise<void>>(async () => {});

		await middleware.handle({ request, response }, next);

		expect(next).not.toHaveBeenCalled();
		expect(readWhole).not.toHaveBeenCalled();
		expect(Buffer.concat(received).equals(content)).toBe(true);
		expect(chunkSizes.length).toBeGreaterThan(1);
		expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(64 * 1024);
		readWhole.mockRestore();
	});

	it("serves an empty file as an empty body", async () => {
		fs.writeFileSync(path.join(root, "empty.txt"), "");
		const { ctx, bodies, response } = makeCtx("GET", "/static/empty.txt");
		const next = vi.fn<() => Promise<void>>(async () => {});

		await middleware.handle(ctx, next);

		expect(next).not.toHaveBeenCalled();
		expect(response.header).toHaveBeenCalledWith("Content-Length", "0");
		expect(bodies).toEqual([Buffer.alloc(0)]);
	});

	/**
	 * The default that made a rebuilt asset invisible: a day of max-age means
	 * the browser does not ask again, so a stylesheet recompiled during
	 * development kept rendering as the previous one, with nothing to see.
	 * Upstream's static server defaults to 0 and revalidates.
	 */
	it("defaults to max-age=0, so a changed file is re-fetched", async () => {
		fs.writeFileSync(path.join(root, "a.css"), "a{}");
		const { ctx, response } = makeCtx("GET", "/static/a.css");

		await middleware.handle(
			ctx,
			vi.fn<() => Promise<void>>(async () => {}),
		);

		expect(response.header).toHaveBeenCalledWith(
			"Cache-Control",
			"public, max-age=0",
		);
	});

	it("still sends an ETag and a Last-Modified, so revalidation is cheap", async () => {
		fs.writeFileSync(path.join(root, "b.css"), "b{}");
		const { ctx, response } = makeCtx("GET", "/static/b.css");

		await middleware.handle(
			ctx,
			vi.fn<() => Promise<void>>(async () => {}),
		);

		const sent = response.header.mock.calls.map((call: unknown[]) => call[0]);
		expect(sent).toContain("ETag");
		expect(sent).toContain("Last-Modified");
	});

	it("honours an explicit maxAge, for content served under a hashed name", async () => {
		fs.writeFileSync(path.join(root, "c.css"), "c{}");
		const hashed = new StaticMiddleware({ root, maxAge: 31536000 });
		const { ctx, response } = makeCtx("GET", "/static/c.css");

		await hashed.handle(
			ctx,
			vi.fn<() => Promise<void>>(async () => {}),
		);

		expect(response.header).toHaveBeenCalledWith(
			"Cache-Control",
			"public, max-age=31536000",
		);
	});

	it("falls through to next() when the file is missing", async () => {
		const { ctx, response } = makeCtx("GET", "/static/never.txt");
		const next = vi.fn<() => Promise<void>>(async () => {});

		await middleware.handle(ctx, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(response.stream).not.toHaveBeenCalled();
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
		expect(response.stream).not.toHaveBeenCalled();
	});

	it("sends a quoted, weak ETag and matches a list weakly", async () => {
		fs.writeFileSync(path.join(root, "b.css"), "body{}");
		const first = makeCtx("GET", "/static/b.css");
		await middleware.handle(first.ctx, vi.fn());
		const etagCall = first.response.header.mock.calls.find(
			(call: unknown[]) => call[0] === "ETag",
		);
		const etag = String(etagCall?.[1]);

		// RFC 9110 §8.8.3 — an entity-tag is a quoted string. The bare md5 hex
		// this used to send is not one, and a strict cache may ignore it.
		expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);

		// §13.1.2 — a list, compared weakly: the strong spelling of a weak tag
		// matches, and so does a tag that is not first.
		const { ctx, response } = makeCtx("GET", "/static/b.css", {
			"if-none-match": `"nope", ${etag.replace(/^W\//, "")}`,
		});
		await middleware.handle(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(304);
		expect(response.stream).not.toHaveBeenCalled();
	});

	it("answers 304 for If-None-Match: *", async () => {
		fs.writeFileSync(path.join(root, "c.css"), "body{}");
		const { ctx, response } = makeCtx("GET", "/static/c.css", {
			"if-none-match": "*",
		});
		await middleware.handle(ctx, vi.fn());
		expect(response.status).toHaveBeenCalledWith(304);
		expect(response.stream).not.toHaveBeenCalled();
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
		expect(response.stream).not.toHaveBeenCalled();

		fs.rmSync(outside, { recursive: true, force: true });
	});

	it("falls through on disallowed extensions", async () => {
		fs.writeFileSync(path.join(root, "secret.env"), "SECRET=1");
		const { ctx, response } = makeCtx("GET", "/static/secret.env");
		const next = vi.fn<() => Promise<void>>(async () => {});
		await middleware.handle(ctx, next);
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.stream).not.toHaveBeenCalled();
	});

	it("never serves a file its visibility marker does not declare public", async () => {
		// The static root may overlap a local disk's root; a file made private
		// there must not come out of here unsigned.
		const write = (name: string, marker?: string) => {
			fs.writeFileSync(path.join(root, name), "content");
			if (marker !== undefined) {
				fs.writeFileSync(
					path.join(root, `${name}.archive-visibility.json`),
					marker,
				);
			}
		};
		write("private.txt", JSON.stringify({ visibility: "private" }));
		write("corrupt.txt", "{not json");
		write("unknown.txt", JSON.stringify({ visibility: "PUBLIC" }));
		write("public.txt", JSON.stringify({ visibility: "public" }));
		write("unmarked.txt");

		const serve = async (name: string) => {
			const { ctx, response } = makeCtx("GET", `/static/${name}`);
			const next = vi.fn<() => Promise<void>>(async () => {});
			await middleware.handle(ctx, next);
			return { served: response.stream.mock.calls.length > 0, next };
		};
		for (const name of ["private.txt", "corrupt.txt", "unknown.txt"]) {
			const { served, next } = await serve(name);
			expect(served, name).toBe(false);
			expect(next, name).toHaveBeenCalledTimes(1);
		}
		expect((await serve("public.txt")).served).toBe(true);
		expect((await serve("unmarked.txt")).served).toBe(true);
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
		expect(response.stream).not.toHaveBeenCalled();
	});
});

describe("StaticMiddleware > percent-encoded paths", () => {
	let root: string;
	let middleware: StaticMiddleware;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-static-enc-"));
		middleware = new StaticMiddleware({ root, prefix: "/static" });
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const request = async (target: string) => {
		const { ctx, bodies } = makeCtx("GET", target);
		const next = vi.fn<() => Promise<void>>(async () => {});
		await middleware.handle(ctx, next);
		const sent = bodies[0];
		return { sent: sent?.toString(), next };
	};

	it("serves a file whose name needs encoding in a URL", async () => {
		fs.mkdirSync(path.join(root, "dossier été"));
		fs.writeFileSync(path.join(root, "my logo.png"), "space");
		fs.writeFileSync(path.join(root, "a+b#c.css"), "reserved");
		fs.writeFileSync(path.join(root, "dossier été", "x.txt"), "unicode");
		expect((await request("/static/my%20logo.png")).sent).toBe("space");
		expect((await request("/static/a%2Bb%23c.css")).sent).toBe("reserved");
		expect((await request("/static/dossier%20%C3%A9t%C3%A9/x.txt")).sent).toBe(
			"unicode",
		);
	});

	it("refuses what only appears once decoded", async () => {
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "archive-static-enc-out-"),
		);
		try {
			fs.writeFileSync(path.join(outside, "secret.txt"), "pwned");
			fs.mkdirSync(path.join(root, "a"));
			fs.writeFileSync(path.join(root, "inner.txt"), "inner");
			fs.writeFileSync(
				path.join(root, "cat.txt.archive-visibility.json"),
				JSON.stringify({ visibility: "private" }),
			);
			const climb = path
				.relative(root, path.join(outside, "secret.txt"))
				.split(path.sep)
				.map((segment) => (segment === ".." ? "%2e%2e" : segment))
				.join("/");
			for (const target of [
				`/static/${climb}`,
				"/static/a/%2E%2E/inner.txt",
				"/static/a%2f..%2finner.txt",
				"/static/a%5c..%5cinner.txt",
				"/static/inner.txt%00.png",
				"/static/%E0%A4%A.txt",
				"/static/cat.txt.archive-visibility%2Ejson",
			]) {
				const { sent, next } = await request(target);
				expect(sent, target).toBeUndefined();
				expect(next, target).toHaveBeenCalledTimes(1);
			}
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
