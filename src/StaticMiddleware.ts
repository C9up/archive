/**
 * Static file serving middleware.
 *
 * Serves files from a directory with cache headers and ETag support.
 *
 * Usage:
 *   const staticMiddleware = new StaticMiddleware({ root: 'public' })
 *   middleware.use(staticMiddleware.handle.bind(staticMiddleware))
 *
 * @implements MISS-25
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_EXTENSIONS, inferMimeType } from "./mime-types.js";
import { VISIBILITY_SIDECAR_SUFFIX } from "./StorageManager.js";

/**
 * Minimal request/response contract the static-file handler needs.
 * Matches Ream's `HttpContext` structurally (public surface only) —
 * avoids importing the concrete class so tests can build plain-object
 * mocks without `as unknown as T` double-casts.
 */
export interface StaticMiddlewareResponse {
	status(code: number): StaticMiddlewareResponse;
	header(name: string, value: string): StaticMiddlewareResponse;
	sendBuffer(buf: Buffer): void;
}

export interface StaticMiddlewareHttpContext {
	request: {
		method(): string;
		path(): string;
		header(name: string): string | undefined;
	};
	response: StaticMiddlewareResponse;
}

export interface StaticConfig {
	/** Root directory to serve files from. */
	root: string;
	/** URL prefix (default: /static). */
	prefix?: string;
	/** Max-age for Cache-Control header in seconds (default: 86400 = 1 day). */
	maxAge?: number;
	/** File extensions to serve (default: common web assets). */
	extensions?: string[];
}

export class StaticMiddleware {
	#root: string;
	#prefix: string;
	#maxAge: number;
	#extensions: Set<string>;

	constructor(config: StaticConfig) {
		const prefix = config.prefix ?? "/static";
		// Reject an empty-string prefix — it would make every GET on an
		// allow-listed extension resolve to a file under `root`, which
		// is rarely what a caller wants and always a misconfiguration
		// risk. Require the caller to pick a real URL prefix.
		if (prefix === "") {
			throw new Error(
				"StaticMiddleware: prefix cannot be empty. Use '/static' (default) or a specific path like '/assets'.",
			);
		}
		const resolved = path.resolve(config.root);
		// Canonicalise the root so the realpath check in handle() can
		// detect symlink-based escapes consistently.
		this.#root = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
		this.#prefix = prefix;
		this.#maxAge = config.maxAge ?? 86400;
		this.#extensions = new Set(config.extensions ?? DEFAULT_EXTENSIONS);
	}

	async handle(
		ctx: StaticMiddlewareHttpContext,
		next: () => Promise<void>,
	): Promise<void> {
		if (ctx.request.method() !== "GET" && ctx.request.method() !== "HEAD") {
			return next();
		}

		const reqPath = ctx.request.path();
		// Match the prefix exactly: `/static/foo` matches prefix `/static`, but
		// `/staticx/foo` must NOT match. Require the char after the prefix to be
		// `/` or end-of-string.
		if (!reqPath.startsWith(this.#prefix)) {
			return next();
		}
		const afterPrefix = reqPath[this.#prefix.length];
		if (afterPrefix !== undefined && afterPrefix !== "/") {
			return next();
		}

		// Strip prefix and resolve file path
		const relativePath = reqPath.slice(this.#prefix.length) || "/index.html";

		// Visibility sidecars are an implementation detail of LocalDriver
		// — never serve them, even if the static root happens to overlap
		// the storage root. Check BEFORE the extension allow-list because
		// `.archive-visibility.json` has a `.json` extension that would
		// otherwise pass. Case-insensitive to defeat
		// `.ARCHIVE-VISIBILITY.JSON` variants on case-insensitive
		// filesystems (macOS default, Windows).
		if (relativePath.toLowerCase().endsWith(VISIBILITY_SIDECAR_SUFFIX)) {
			return next();
		}

		const ext = path.extname(relativePath).toLowerCase();

		if (!this.#extensions.has(ext)) {
			return next();
		}

		// Prevent path traversal (lexical check first).
		const filePath = path.resolve(this.#root, relativePath.replace(/^\//, ""));
		if (
			!filePath.startsWith(this.#root + path.sep) &&
			filePath !== this.#root
		) {
			return next();
		}

		let stat: Awaited<ReturnType<typeof fsp.stat>>;
		let realPath: string;
		try {
			stat = await fsp.stat(filePath);
			if (!stat.isFile()) return next();
			// Realpath guard — defeats symlink-based escapes where a
			// symlink inside `root` points to a file outside it.
			realPath = await fsp.realpath(filePath);
			if (
				!realPath.startsWith(this.#root + path.sep) &&
				realPath !== this.#root
			) {
				return next();
			}
		} catch {
			return next();
		}

		const etag = createHash("md5")
			.update(`${stat.size}-${stat.mtimeMs}`)
			.digest("hex");

		// ETag check — 304 Not Modified
		const ifNoneMatch = ctx.request.header("if-none-match");
		if (ifNoneMatch === etag) {
			ctx.response.status(304);
			return;
		}

		const mime = inferMimeType(ext);
		ctx.response.header("Content-Type", mime);
		ctx.response.header("Content-Length", String(stat.size));
		ctx.response.header("Cache-Control", `public, max-age=${this.#maxAge}`);
		ctx.response.header("ETag", etag);

		if (ctx.request.method() === "HEAD") {
			ctx.response.status(200);
			return;
		}

		// Opened with O_NOFOLLOW rather than read by name.
		//
		// Reading the canonicalised path narrowed the window but did not close
		// it: between `realpath` and the read, the last component of that path
		// can be replaced by a symlink pointing anywhere, and a read by name
		// follows it. Refusing to follow a link at open time takes the swap off
		// the table — the open fails instead of serving a file outside the root.
		//
		// A parent directory swapped in the same window is not covered; that
		// needs openat-relative-to-a-descriptor, which Node does not expose.
		let content: Buffer;
		try {
			const handle = await fsp.open(
				realPath,
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
			);
			try {
				content = await handle.readFile();
			} finally {
				await handle.close();
			}
		} catch {
			return next();
		}
		// Send the raw Buffer — NOT content.toString() which would destroy binary
		// data (PNG, PDF, ZIP, etc.) by interpreting it as UTF-8.
		ctx.response.status(200).sendBuffer(content);
	}
}
