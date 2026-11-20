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

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { matchesIfNoneMatch, statTag } from "./etag.js";
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
	/**
	 * Send a readable as the body. The framework's response streams it to
	 * the client, so a request never holds the whole file in memory.
	 */
	stream(body: NodeJS.ReadableStream): Promise<void> | void;
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
	/**
	 * `max-age` in seconds. Default 0, as AdonisJS's static server is.
	 *
	 * Zero does NOT mean "do not cache": the response still carries an ETag and
	 * a Last-Modified, so a browser keeps the bytes and asks whether they are
	 * still good — answered with a 304 and no body. What zero removes is the
	 * window in which it does not ask at all.
	 *
	 * The old default was a day, which is right for fingerprinted assets and
	 * wrong for everything else: a stylesheet rebuilt during development was
	 * not re-fetched for 24 hours, so the page kept rendering with the previous
	 * one and nothing about it looked broken.
	 *
	 * Set it high for content served under a content-addressed name, or put a
	 * CDN in front — which is what upstream recommends for production anyway.
	 */
	maxAge?: number;
	/** File extensions to serve (default: common web assets). */
	extensions?: string[];
}

/**
 * Whether a file may be served unsigned, by its local-disk visibility marker.
 *
 * No marker is the local disk's default, public. A marker that says exactly
 * `public` is public. Anything else — private, unreadable, malformed, or a
 * value that is neither — is not served: an undetermined visibility must
 * never be read as public.
 */
async function declaredPublic(file: string): Promise<boolean> {
	let raw: string;
	try {
		const handle = await fsp.open(
			file + VISIBILITY_SIDECAR_SUFFIX,
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
		);
		try {
			raw = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch (err) {
		return isErrnoCode(err, "ENOENT");
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"visibility" in parsed &&
			parsed.visibility === "public"
		);
	} catch {
		return false;
	}
}

/**
 * Percent-decode a request path segment by segment, or `undefined` when it
 * cannot be served: a malformed escape, or a segment that decodes to a
 * separator, a control character or a dot-only name. Those only appear once
 * decoded, so a check on the raw path would miss them — and a dot-only
 * segment is refused even when it would stay inside the root, as a static
 * file server refuses `..` outright.
 */
function decodePath(raw: string): string | undefined {
	const segments: string[] = [];
	for (const segment of raw.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			return undefined;
		}
		if (!isPlainSegment(decoded)) return undefined;
		if (/^\.{2,}$/.test(decoded)) return undefined;
		segments.push(decoded);
	}
	return segments.join("/");
}

/** No separator and no control character in one decoded segment. */
function isPlainSegment(segment: string): boolean {
	for (let i = 0; i < segment.length; i++) {
		const code = segment.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return false;
		if (segment[i] === "/" || segment[i] === "\\") return false;
	}
	return true;
}

/** Whether `err` is a filesystem error carrying `code`. */
function isErrnoCode(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		err.code === code
	);
}

/**
 * The first `size` bytes of an open file, as a stream that owns the
 * descriptor. An empty file gets an empty stream (a read range cannot end
 * before it starts), and its descriptor is closed here.
 */
function bodyOf(handle: fsp.FileHandle, size: number): NodeJS.ReadableStream {
	if (size === 0) {
		void handle.close().catch(() => {});
		return Readable.from([]);
	}
	return handle.createReadStream({ start: 0, end: size - 1 });
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
		this.#maxAge = config.maxAge ?? 0;
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

		// Strip the prefix and percent-decode. The framework hands over the raw
		// request target, so `my%20logo.png` used to be looked up literally
		// and every name with a space, `+`, `#` or a non-ASCII letter was
		// unreachable. Every check below runs on the DECODED path, which is
		// the one the filesystem sees.
		const relativePath = decodePath(
			reqPath.slice(this.#prefix.length) || "/index.html",
		);
		if (relativePath === undefined) return next();

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

		// The static root may overlap a local disk's root, where a file made
		// private carries a visibility marker beside it. Serving it here,
		// unsigned, would make `setVisibility('private')` protect nothing.
		if (!(await declaredPublic(realPath))) return next();

		// Quoted and weak (RFC 9110 §8.8.3): the bare md5 hex this used to send
		// is not a valid entity-tag, and a strict cache may ignore it outright.
		const etag = statTag(stat);

		// ETag check — 304 Not Modified. The header is a list compared weakly
		// (§13.1.2); raw equality missed a client sending two tags, or one
		// sending back `W/"x"` for a tag we wrote as `"x"`.
		if (matchesIfNoneMatch(ctx.request.header("if-none-match"), etag)) {
			ctx.response.status(304);
			return;
		}

		const mime = inferMimeType(ext);
		ctx.response.header("Content-Type", mime);
		ctx.response.header("Content-Length", String(stat.size));
		ctx.response.header("Cache-Control", `public, max-age=${this.#maxAge}`);
		ctx.response.header("ETag", etag);
		// Sent alongside the ETag, as upstream does. A client that revalidates
		// with `If-Modified-Since` rather than `If-None-Match` has nothing to
		// compare against without it.
		ctx.response.header("Last-Modified", stat.mtime.toUTCString());

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
		let handle: fsp.FileHandle;
		try {
			handle = await fsp.open(
				realPath,
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
			);
		} catch {
			return next();
		}
		// Streamed from the descriptor, never read whole: a buffered read held
		// one full copy of the file per request until the response flushed, and
		// a file past Node's 2 GiB read cap could not be served at all. The
		// stream owns the descriptor and closes it when it ends, fails or is
		// abandoned by a client that left. It stops at the size the
		// Content-Length announced, so a file that grows meanwhile cannot
		// overrun it.
		ctx.response.status(200);
		await ctx.response.stream(bodyOf(handle, stat.size));
	}
}
