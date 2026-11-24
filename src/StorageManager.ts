/**
 * Storage — file storage abstraction with driver pattern.
 *
 * @implements MISS-24
 */

import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import * as url from "node:url";
import { errnoCode } from "./errno.js";
import {
	E_ARCHIVE_INVALID_DRIVER_CONFIG,
	E_ARCHIVE_INVALID_KEY,
	E_ARCHIVE_INVALID_ROUTE_BASE_PATH,
	E_ARCHIVE_NOT_FOUND,
	E_ARCHIVE_PATH_TRAVERSAL_DETECTED,
	E_ARCHIVE_SIGNED_UPLOAD_UNSUPPORTED,
	E_ARCHIVE_SIGNING_DISABLED,
	E_ARCHIVE_VISIBILITY_CORRUPT,
	E_ARCHIVE_VISIBILITY_MOVE_FAILED,
	E_ARCHIVE_WEAK_SIGNING_SECRET,
	E_CANNOT_COPY_FILE,
	E_CANNOT_DELETE_DIRECTORY,
	E_CANNOT_DELETE_FILE,
	E_CANNOT_GENERATE_URL,
	E_CANNOT_MOVE_FILE,
	E_CANNOT_SET_VISIBILITY,
	E_CANNOT_WRITE_FILE,
} from "./errors.js";
import {
	assertValidExpiry,
	DEFAULT_EXPIRES_IN,
	parseExpiry,
} from "./expiry.js";
import { isKeyRefusal, normalizeKey, normalizePrefix } from "./keys.js";
import {
	overrideQuery,
	requestedOverrides,
	servedPath,
	signedPayload,
} from "./local-signature.js";
import { inferMimeType } from "./mime-types.js";
import {
	DriveDirectory,
	DriveFile,
	type FileSnapshot,
	wrapFailure,
} from "./objects.js";

export { DriveDirectory, DriveFile } from "./objects.js";

/** Options for {@link StorageDriver.getSignedUrl}. */
export interface SignedUrlOptions {
	/**
	 * URL lifetime. Either a number of seconds or an AdonisJS-style
	 * duration string (`'30mins'`, `'7 days'`, `'1h'`). Default: 300
	 * (5 minutes). Bounds after parsing: 1–604800.
	 */
	expiresIn?: number | string;
	/**
	 * Sets the response `Content-Type` served with the signed URL. Cloud
	 * drivers pass it to the provider; the local disk signs it into the URL
	 * and the signed route sends it.
	 */
	contentType?: string;
	/**
	 * Sets the response `Content-Disposition` served with the signed URL —
	 * `attachment; filename="…"` to download rather than display. Same
	 * handling as {@link SignedUrlOptions.contentType}.
	 */
	contentDisposition?: string;
}

/**
 * Options accepted by the write operations (`put`/`putStream`) and by
 * `copy`/`move`. AdonisJS Drive `WriteOptions` parity. Cloud drivers map
 * these onto object metadata headers; the LocalDriver honours only
 * `visibility` (the rest have no filesystem equivalent).
 */
export interface WriteOptions {
	/** Visibility to apply to the written / copied object. */
	visibility?: Visibility;
	/** `Content-Type` metadata. Falls back to extension-based inference. */
	contentType?: string;
	/** `Cache-Control` metadata (cloud drivers). */
	cacheControl?: string;
	/** `Content-Disposition` metadata (cloud drivers). */
	contentDisposition?: string;
	/** Declared byte length. Used by S3 to choose single-PUT vs multipart. */
	contentLength?: number;
}

/** Result shape of {@link StorageDriver.listAll} — AdonisJS Drive parity. */
export interface ListAllResult {
	/** Continuation token to fetch the next page (cloud drivers only). */
	paginationToken?: string;
	/** Files and (non-recursive only) directories under the prefix. */
	objects: Iterable<DriveFile | DriveDirectory>;
}

/** Options accepted by {@link StorageDriver.listAll}. */
export interface ListAllOptions {
	/** Recurse into sub-prefixes. When true, no directories are yielded. */
	recursive?: boolean;
	/** Continuation token from a previous page (cloud drivers only). */
	paginationToken?: string;
}

/** Options for {@link StorageDriver.putStream}. */
export interface PutStreamOptions {
	/**
	 * Visibility of the written object, applied as `put()` applies it: on the
	 * local disk a private marker is down before the first byte.
	 */
	visibility?: Visibility;
	/** MIME type — sent as unsigned `Content-Type` on S3 uploads. Local ignores it. */
	contentType?: string;
	/**
	 * Declared byte length. S3 uses this to pick single-PUT (≤ 5 MiB) vs
	 * multipart (> 5 MiB). Undefined → always multipart. Local ignores it.
	 */
	contentLength?: number;
}

/** Public/private visibility for a stored object. */
export type Visibility = "public" | "private";

/** Suffix appended to the target filename to store its visibility marker
 *  on the LocalDriver. Kept as a package-internal constant so the static
 *  middleware can exclude it by the same name. */
export const VISIBILITY_SIDECAR_SUFFIX = ".archive-visibility.json";

/**
 * Metadata surfaced by {@link StorageDriver.getMetadata}. Shape is driver-
 * agnostic: S3 returns HEAD-derived values, Local reads `fs.stat` + the
 * MIME table + a sidecar for visibility.
 */
/** One entry yielded by {@link StorageDriver.list}. */
export interface StorageEntry {
	/** Full path (includes the prefix argument). */
	path: string;
	/** Size in bytes. */
	size: number;
	/** Last-modified timestamp. */
	lastModified: Date;
}

export interface Metadata {
	/** Size in bytes. */
	size: number;
	/** AdonisJS `ObjectMetaData` alias of {@link Metadata.size}. Same value. */
	contentLength: number;
	/** Content type. Driver-inferred for Local (extension-based), server-
	 *  reported for S3. Falls back to `application/octet-stream`. */
	mimeType: string;
	/** AdonisJS `ObjectMetaData` alias of {@link Metadata.mimeType}. Same value. */
	contentType: string;
	/** Last-modified timestamp as a `Date` — not a string, not epoch ms. */
	lastModified: Date;
	/** Strong or weak ETag with surrounding quotes stripped. `W/` prefix
	 *  is preserved when the origin reports a weak tag. */
	etag: string;
	/** Public/private visibility. Missing marker on Local = the disk's visibility. */
	visibility: Visibility;
}

/**
 * StorageDriver contract — v1.1 (Epic 43, extended for AdonisJS Drive /
 * flydrive parity 2026-07-06).
 *
 * Driver authors implement this interface verbatim. The interface is treated
 * as a stable contract: methods are added only to track upstream Drive
 * parity. Method signatures never change in-place — a renamed method ships as
 * a new method + the old one delegating, deprecated for ≥1 epic.
 */
export interface StorageDriver {
	put(
		filePath: string,
		content: Buffer | string,
		options?: WriteOptions,
	): Promise<void>;
	/**
	 * Upload from a readable stream. Local pipes to disk; S3 uses
	 * single-PUT if `contentLength ≤ 5 MiB`, otherwise multipart.
	 */
	putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		options?: PutStreamOptions,
	): Promise<void>;
	/**
	 * Raw contents as a `Buffer`, or `null` when the object is absent.
	 *
	 * DIVERGENCE from AdonisJS Drive (documented, deliberate): Adonis
	 * `get()` returns a UTF-8 `string` and throws on absence. Ream keeps
	 * the binary-safe `Buffer | null` shape as a superset. Use
	 * {@link StorageDriver.getBytes} for the Adonis-shaped, throw-on-
	 * absence accessor.
	 */
	get(filePath: string): Promise<Buffer | null>;
	/**
	 * Contents as a `Uint8Array`. AdonisJS Drive parity. Throws
	 * `E_ARCHIVE_NOT_FOUND` when the object is absent (unlike {@link get},
	 * a byte accessor can't express absence as a value).
	 */
	getBytes(filePath: string): Promise<Uint8Array>;
	/**
	 * Download as a readable stream. Throws `E_ARCHIVE_NOT_FOUND` when
	 * the object is missing — streams can't express absence as a value.
	 */
	getStream(filePath: string): Promise<NodeJS.ReadableStream>;
	delete(filePath: string): Promise<boolean>;
	exists(filePath: string): Promise<boolean>;
	/**
	 * Visibility-aware URL. `public` → {@link publicUrl}, `private` →
	 * {@link getSignedUrl} (default 5 min expiry). Async because reading
	 * visibility may require a driver round-trip (S3 GET ?acl).
	 */
	url(filePath: string): Promise<string>;
	/**
	 * Unsigned, direct URL that ignores visibility. Useful when the
	 * caller already knows the object is public or wants to build a
	 * template before visibility is set.
	 */
	publicUrl(filePath: string): string;
	/**
	 * Return a time-boxed URL that grants read access to `filePath`.
	 * Implementations must validate `options.expiresIn` via
	 * {@link assertValidExpiry} and reject out-of-range values with
	 * `E_ARCHIVE_INVALID_EXPIRY`.
	 */
	getSignedUrl(
		filePath: string,
		options?: SignedUrlOptions,
	): string | Promise<string>;
	/**
	 * Return a time-boxed URL that grants **write** (PUT) access, letting
	 * a client upload directly to the backend. AdonisJS Drive parity.
	 * Cloud-only — the LocalDriver has no presigned-upload equivalent and
	 * throws `E_ARCHIVE_SIGNED_UPLOAD_UNSUPPORTED`.
	 */
	getSignedUploadUrl(
		filePath: string,
		options?: SignedUrlOptions,
	): string | Promise<string>;
	/**
	 * Resolve object metadata. Throws `E_ARCHIVE_NOT_FOUND`
	 * when the object does not exist.
	 */
	getMetadata(filePath: string): Promise<Metadata>;
	/**
	 * Resolve the `public` / `private` visibility of an object on its own,
	 * without a full metadata round-trip. AdonisJS Drive parity.
	 */
	getVisibility(filePath: string): Promise<Visibility>;
	/**
	 * Set `public` / `private` visibility. Idempotent — re-applying the
	 * same visibility succeeds silently.
	 */
	setVisibility(filePath: string, visibility: Visibility): Promise<void>;
	/**
	 * Duplicate an object. Throws `E_ARCHIVE_NOT_FOUND` if `from` is
	 * missing. Target is overwritten if it exists. The copy takes the
	 * SOURCE's visibility unless `options.visibility` is passed (flydrive
	 * parity): copying a private object never yields a public one.
	 */
	copy(from: string, to: string, options?: WriteOptions): Promise<void>;
	/**
	 * Relocate an object. Equivalent to `copy` + `delete` on cloud
	 * drivers (non-atomic between the two steps); atomic `rename` on
	 * Local. Visibility IS preserved because identity is preserved.
	 */
	move(from: string, to: string, options?: WriteOptions): Promise<void>;
	/**
	 * Delete every object under the directory `prefix` names: `users/1` and
	 * `users/1/` both reach `users/1/**`, never `users/10/**` (see
	 * `normalizePrefix`). Local removes the matching files (and prunes
	 * emptied directories); S3 batch-deletes; GCS deletes per object.
	 */
	deleteAll(prefix: string): Promise<void>;
	/**
	 * Yield one {@link StorageEntry} per object under the directory `prefix`
	 * names (same rule as {@link deleteAll}). Pagination (S3/GCS) and filesystem walk (Local) happen
	 * lazily — callers can `break` early and no further requests are
	 * issued. Ream superset — kept alongside the Adonis-shaped
	 * {@link StorageDriver.listAll}.
	 */
	list(prefix: string): AsyncIterable<StorageEntry>;
	/**
	 * AdonisJS Drive `listAll`: a single page of {@link DriveFile} (and,
	 * when non-recursive, {@link DriveDirectory}) entries plus an optional
	 * pagination token.
	 */
	listAll(prefix: string, options?: ListAllOptions): Promise<ListAllResult>;
}

export interface LocalDriverOptions {
	/**
	 * HMAC-SHA256 secret used by {@link LocalDriver.getSignedUrl}.
	 * When omitted, signing is disabled and `getSignedUrl` throws
	 * `E_ARCHIVE_SIGNING_DISABLED`. The non-signing methods
	 * (`put`/`get`/`delete`/`exists`/`url`) work either way.
	 *
	 * A string, or a `Secret` (`env.get('APP_KEY')` when the env schema
	 * declares it with `Env.schema.secret()`), released once by the driver.
	 */
	signingSecret?: string | ReleasableSecret;
	/**
	 * The URL path files are served under (default `/storage`). `publicUrl`,
	 * `url` and `getSignedUrl` build on it, and the signed route reads it from
	 * the driver, so the URLs handed out and the route serving them cannot
	 * disagree. A trailing `/` is dropped.
	 */
	routeBasePath?: string;
	/**
	 * The disk's visibility (flydrive's FS driver option of the same name),
	 * default `'public'`.
	 *
	 * - `'private'`: every object on the disk is private, whatever a write or
	 *   `setVisibility()` asks for. `getVisibility()` answers `private`,
	 *   `url()` signs, and the signed route refuses every unsigned request
	 *   before it looks at the file. Each write also leaves a private marker
	 *   beside the file, so a static server mounted over the root, or the
	 *   disk later switched to public, still sees it as private.
	 * - `'public'`: an object written without a visibility is public, and a
	 *   write or `setVisibility()` can make one private — per-object
	 *   visibility, which flydrive's FS driver does not have (its
	 *   `setVisibility` is a no-op).
	 */
	visibility?: Visibility;
}

/** Anything that releases a secret string — an environment `Secret`. */
export interface ReleasableSecret {
	release(): string;
}

/**
 * The secret as a string, or `undefined` when it is neither a string nor a
 * Secret wrapping one. Typed configs cannot hand over anything else; the
 * guard is for an untyped (JavaScript) config, whose `Secret` would otherwise
 * reach the HMAC as its redacted placeholder text.
 */
function releaseSecret(secret: unknown): string | undefined {
	if (typeof secret === "string") return secret;
	if (typeof secret === "object" && secret !== null && "release" in secret) {
		const release: unknown = secret.release;
		if (typeof release === "function") {
			const released: unknown = release.call(secret);
			if (typeof released === "string") return released;
		}
	}
	return undefined;
}

/**
 * `O_NOFOLLOW`, or nothing on a platform without it.
 *
 * Windows has no symlink-refusing open and leaves `fs.constants.O_NOFOLLOW`
 * undefined; or-ing that into the flags yields `NaN` and every open fails, so
 * the flag is contributed only where it exists.
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * A route base path, without its trailing `/`. Refused unless it is an
 * absolute URL path with at least one segment and nothing a URL would read
 * as a query, a fragment or a break.
 */
function routeBasePath(given: string): string {
	const trimmed = given.replace(/\/+$/, "");
	if (!/^(\/[^/?#\s]+)+$/.test(trimmed)) {
		throw new E_ARCHIVE_INVALID_ROUTE_BASE_PATH([JSON.stringify(given)]);
	}
	return trimmed;
}

export class LocalDriver implements StorageDriver {
	#root: string;
	#signingSecret: string | null;
	#routeBasePath: string;
	#visibility: Visibility;

	/**
	 * The only synchronous filesystem access left in this driver, and the only
	 * one that cannot be anything else: a constructor cannot await. It runs
	 * once, at boot, before the server is serving. Every method below is
	 * asynchronous — they used to be async signatures over `writeFileSync` /
	 * `readFileSync`, so a large upload or download stalled every other
	 * request in the process for its whole duration.
	 */
	constructor(root: string, options?: LocalDriverOptions) {
		// Validated before the root is created: a refused config leaves
		// nothing behind on disk.
		this.#routeBasePath = routeBasePath(options?.routeBasePath ?? "/storage");
		// NAMED DEVIATION: optional, where flydrive's FS driver requires it.
		// Omitted, the disk is public, as every local disk was before the
		// option existed. `services.fs()` requires it, as upstream does.
		const visibility: unknown = options?.visibility ?? "public";
		if (visibility !== "public" && visibility !== "private") {
			// An untyped config: a misspelt value must not quietly become public.
			throw new E_ARCHIVE_INVALID_DRIVER_CONFIG([
				`LocalDriver: visibility must be 'public' or 'private', got ${JSON.stringify(visibility)}.`,
			]);
		}
		this.#visibility = visibility;
		const resolved = path.resolve(root);
		if (!fs.existsSync(resolved)) {
			fs.mkdirSync(resolved, { recursive: true });
		}
		// Canonicalise the root once so subsequent realpath-based
		// escape checks compare apples to apples.
		this.#root = fs.realpathSync(resolved);
		const configured = options?.signingSecret;
		let secret: string | null = null;
		if (configured !== undefined) {
			const released = releaseSecret(configured);
			// Empty or trivially short secrets defeat the whole point of
			// HMAC signing. 16 bytes is the floor: rejects obviously weak
			// values without being annoyingly strict about format.
			if (released === undefined || released.length < 16) {
				throw new E_ARCHIVE_WEAK_SIGNING_SECRET([
					released === undefined ? "neither" : `length ${released.length}`,
				]);
			}
			secret = released;
		}
		this.#signingSecret = secret;
	}

	/**
	 * The half of the guard that touches nothing: control characters and
	 * lexical containment.
	 *
	 * Split out because `getSignedUrl` is synchronous in the driver contract
	 * and cannot await the symlink walk. Keeping ONE implementation of each
	 * half — rather than a sync copy of the whole check beside an async one —
	 * is what stops the two from drifting apart, which for a containment guard
	 * is the failure that matters.
	 */
	#lexicalPath(filePath: string): string {
		const key = this.#key(filePath);
		const full = path.resolve(this.#root, key);
		// Lexical guard, kept behind the normaliser: a normalised key has no
		// `..` and no leading `/`, but a drive-letter key resolves to an
		// absolute path on Windows, and a containment check is not where to
		// rely on one layer only.
		if (!full.startsWith(this.#root + path.sep)) {
			throw Object.assign(
				new E_ARCHIVE_PATH_TRAVERSAL_DETECTED([
					`Path traversal blocked: '${filePath}' resolves outside storage root`,
				]),
				{ help: "Keys are relative to the disk root." },
			);
		}
		return full;
	}

	/**
	 * The normalised key (see `keys.ts`), refused when it names a visibility
	 * marker.
	 *
	 * Control characters are refused by the normaliser; that matters here
	 * because `\n` is the signing payload separator — a key containing one
	 * could otherwise forge `exp`.
	 */
	#key(filePath: string): string {
		const key = normalizeKey(filePath);
		// The visibility markers live beside the files they describe, so a key
		// naming one would let a caller write, delete or read the marker of
		// another file — `put("secret.pdf.archive-visibility.json", …)` turned a
		// private file public. Refused on every segment (a marker name used as a
		// directory blocks the marker write too) and case-insensitively (the
		// same file on a case-insensitive filesystem).
		for (const segment of key.split("/")) {
			if (segment.toLowerCase().endsWith(VISIBILITY_SIDECAR_SUFFIX)) {
				throw Object.assign(
					new E_ARCHIVE_INVALID_KEY([
						`Invalid key '${filePath}': names ending in '${VISIBILITY_SIDECAR_SUFFIX}' are reserved for visibility markers`,
					]),
					{ help: "Store the object under a name without that suffix." },
				);
			}
		}
		return key;
	}

	/**
	 * Resolve and validate a file path — prevents traversal outside
	 * the root, INCLUDING via symlinks planted inside the root.
	 *
	 * For existing files the check walks `realpath(full)` to defeat symlink
	 * redirection. For new writes (target doesn't exist yet) we walk the
	 * nearest existing ancestor so an attacker who planted a symlink at
	 * `<root>/evil -> /etc` cannot redirect a put through it.
	 */
	async #safePath(filePath: string): Promise<string> {
		const full = this.#lexicalPath(filePath);
		// Realpath guard — walk up to the nearest existing ancestor and
		// confirm its canonical form is still under root.
		let probe = full;
		for (;;) {
			try {
				const realProbe = await fsp.realpath(probe);
				if (
					!realProbe.startsWith(this.#root + path.sep) &&
					realProbe !== this.#root
				) {
					throw Object.assign(
						new E_ARCHIVE_PATH_TRAVERSAL_DETECTED([
							`Path traversal blocked: '${filePath}' resolves outside storage root via symlink`,
						]),
						{ help: "A link inside the disk root points outside it." },
					);
				}
				return full;
			} catch (err) {
				if (errnoCode(err) !== "ENOENT") throw err;
				const parent = path.dirname(probe);
				// The root itself is canonicalised at construction, so the walk
				// always terminates at something that resolves.
				if (parent === probe) return full;
				probe = parent;
			}
		}
	}

	async put(
		filePath: string,
		content: Buffer | string,
		options?: WriteOptions,
	): Promise<void> {
		const full = await this.#safePath(filePath);
		await fsp.mkdir(path.dirname(full), { recursive: true });
		// Written through a descriptor opened with O_NOFOLLOW, not by name.
		//
		// `#safePath` canonicalises and checks, then returns a STRING, and the
		// write happened later against that string. Between the two, the last
		// component can be replaced by a symlink pointing anywhere, and a write
		// by name follows it — the check passed on one object and the write
		// landed on another. Refusing to follow a link at open time takes the
		// swap off the table: the open fails instead of writing outside the root.
		//
		// Only `visibility` has a filesystem-equivalent (the marker);
		// contentType/cacheControl/... have no local meaning.
		await this.#writeMarked(
			full,
			this.#intended(options?.visibility),
			async () => {
				const handle = await fsp.open(
					full,
					fs.constants.O_WRONLY |
						fs.constants.O_CREAT |
						fs.constants.O_TRUNC |
						O_NOFOLLOW,
					0o666,
				);
				try {
					await handle.writeFile(content);
				} finally {
					await handle.close();
				}
			},
		);
	}

	/**
	 * The visibility a write leaves its object with: the one asked for on a
	 * public disk (`undefined` keeps the object's current marker), always
	 * `private` on a private disk.
	 */
	#intended(visibility: Visibility | undefined): Visibility | undefined {
		return this.#visibility === "private" ? "private" : visibility;
	}

	/**
	 * Run `write`, which puts data at `full`, and leave the object with
	 * `visibility` — without it ever being readable as public while it should
	 * not be.
	 *
	 * The marker is a second file, and its absence means public. A PRIVATE
	 * marker therefore goes down BEFORE the data: written after, the object
	 * was public for the whole write — served unsigned by the signed route and
	 * by a static server over the disk — and stayed public for good when the
	 * marker write failed. If the data write then fails, the half-written
	 * object is removed, and its marker only once the data is gone: the object
	 * ends private or absent, never public.
	 *
	 * A PUBLIC marker goes down AFTER the data, for the same reason the other
	 * way round: the bytes being replaced may be private, and they keep their
	 * marker until the new ones have landed.
	 */
	async #writeMarked(
		full: string,
		visibility: Visibility | undefined,
		write: () => Promise<void>,
	): Promise<void> {
		if (visibility !== "private") {
			await write();
			if (visibility !== undefined) await this.#writeMarker(full, visibility);
			return;
		}
		await this.#markPrivate(full);
		try {
			await write();
		} catch (err) {
			await discardPrivate(full);
			throw err;
		}
	}

	/**
	 * Mark `full` private before its data is touched. A marker write that
	 * fails puts the previous marker back (or leaves a damaged one, which
	 * reads as undetermined and is served to nobody), and rethrows: the
	 * caller writes no data.
	 */
	async #markPrivate(full: string): Promise<MarkerSnapshot> {
		const previous = await markerSnapshot(full);
		try {
			await this.#writeMarker(full, "private");
		} catch (err) {
			await restoreMarker(full, previous);
			throw err;
		}
		return previous;
	}

	/**
	 * Write the visibility marker of the file at `full`, a path `#safePath`
	 * already resolved. Through an O_NOFOLLOW descriptor, as the data is: a
	 * link planted at the marker's name is refused rather than followed to
	 * write outside the root.
	 */
	async #writeMarker(full: string, visibility: Visibility): Promise<void> {
		const handle = await fsp.open(
			full + VISIBILITY_SIDECAR_SUFFIX,
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_TRUNC |
				O_NOFOLLOW,
			0o666,
		);
		try {
			await handle.writeFile(JSON.stringify({ visibility }));
		} finally {
			await handle.close();
		}
	}

	async getBytes(filePath: string): Promise<Uint8Array> {
		const buf = await this.get(filePath);
		if (buf === null) {
			throw Object.assign(
				new E_ARCHIVE_NOT_FOUND([`File does not exist at path '${filePath}'`]),
				{ help: "Confirm the path and that the file was put() first." },
			);
		}
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	async putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		// LocalDriver ignores contentType (inferred from extension via
		// getMetadata) and contentLength (FS knows its own size).
		options?: PutStreamOptions,
	): Promise<void> {
		const full = await this.#safePath(filePath);
		await fsp.mkdir(path.dirname(full), { recursive: true });
		// Marked as put() marks: a private marker before the first byte, a
		// stream that fails half-way leaves nothing behind. Ignoring the
		// visibility here made `copyFromFs(…, { visibility: 'private' })`
		// store a public file.
		await this.#writeMarked(
			full,
			this.#intended(options?.visibility),
			async () => {
				// Same descriptor-first rule as put(): the stream is created FROM
				// the handle, so it writes to the object the open accepted rather
				// than to whatever the name points at when the first chunk arrives.
				const handle = await fsp.open(
					full,
					fs.constants.O_WRONLY |
						fs.constants.O_CREAT |
						fs.constants.O_TRUNC |
						O_NOFOLLOW,
					0o666,
				);
				// `pipeline` propagates errors and destroys the write target on
				// failure — and closing the stream closes the handle it was made
				// from.
				await pipeline(readable, handle.createWriteStream());
			},
		);
	}

	async get(filePath: string): Promise<Buffer | null> {
		const full = await this.#safePath(filePath);
		try {
			// Read through a descriptor, refusing to follow a link — see put().
			const handle = await fsp.open(full, fs.constants.O_RDONLY | O_NOFOLLOW);
			try {
				return await handle.readFile();
			} finally {
				await handle.close();
			}
		} catch (err) {
			// One syscall instead of exists-then-read: the pair also answered
			// `null` for a file that was deleted between the two.
			if (errnoCode(err) === "ENOENT") return null;
			throw err;
		}
	}

	async getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		const full = await this.#safePath(filePath);
		// One open instead of exists-then-create: the pair also handed back a
		// stream over whatever replaced the file between the two calls, and it
		// followed a symlink planted there. The open refuses the link and IS the
		// existence check.
		let handle: fsp.FileHandle;
		try {
			handle = await fsp.open(full, fs.constants.O_RDONLY | O_NOFOLLOW);
		} catch (err) {
			if (errnoCode(err) === "ENOENT") {
				throw Object.assign(
					new E_ARCHIVE_NOT_FOUND([
						`File does not exist at path '${filePath}'`,
					]),
					{ help: "Confirm the path and that the file was put() first." },
				);
			}
			throw err;
		}
		// Closing the stream closes the handle it was made from.
		return handle.createReadStream();
	}

	async delete(filePath: string): Promise<boolean> {
		const full = await this.#safePath(filePath);
		try {
			await fsp.unlink(full);
		} catch (err) {
			if (errnoCode(err) === "ENOENT") return false;
			throw err;
		}
		// Sidecar cleanup is best-effort. The main file is already gone
		// — any sidecar failure (ENOENT, EACCES, EPERM) would corrupt
		// the `delete` contract if we threw here (caller would see a
		// rejected Promise AFTER the file was already deleted).
		const sidecar = full + VISIBILITY_SIDECAR_SUFFIX;
		try {
			await fsp.unlink(sidecar);
		} catch {
			// swallow: cleanup is best-effort.
		}
		return true;
	}

	async exists(filePath: string): Promise<boolean> {
		// A marker name is refused by the path guard, as by every other method.
		return exists(await this.#safePath(filePath));
	}

	publicUrl(filePath: string): string {
		// Encode each segment so special chars (`?`, `#`, spaces, unicode)
		// survive the trip through an HTTP layer. The middleware mirrors
		// this by decoding each segment before recomputing the HMAC —
		// skipping encoding here would leave the URL unparseable.
		const encoded = this.#key(filePath)
			.split("/")
			.map((seg) => encodeURIComponent(seg))
			.join("/");
		return `${this.#routeBasePath}/${encoded}`;
	}

	/**
	 * The URL path this driver's files are served under. The signed route
	 * reads it, so the URLs this driver builds and the route that serves them
	 * derive from one value.
	 */
	getRouteBasePath(): string {
		return this.#routeBasePath;
	}

	/**
	 * The disk's own visibility (the `visibility` option). The signed route
	 * reads it to refuse every unsigned request on a private disk before it
	 * looks at the file.
	 */
	getDiskVisibility(): Visibility {
		return this.#visibility;
	}

	async url(filePath: string): Promise<string> {
		const visibility = await this.#readVisibility(filePath);
		if (visibility === "public") return this.publicUrl(filePath);
		return this.getSignedUrl(filePath);
	}

	async getMetadata(filePath: string): Promise<Metadata> {
		const full = await this.#safePath(filePath);
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(full);
		} catch (err) {
			if (errnoCode(err) === "ENOENT") {
				throw Object.assign(
					new E_ARCHIVE_NOT_FOUND([
						`File does not exist at path '${filePath}'`,
					]),
					{ help: "Confirm the path and that the file was put() first." },
				);
			}
			throw err;
		}
		// Stat-based weak ETag: inode+size+mtime is cheap and matches
		// the behaviour of nginx/Apache for static files. A strong ETag
		// would require reading the full content — not worth it for a
		// HEAD-equivalent call.
		const etagBody = createHash("sha1")
			.update(`${stat.ino}-${stat.size}-${stat.mtimeMs}`)
			.digest("hex");
		const mimeType = inferMimeType(path.extname(filePath).toLowerCase());
		return {
			size: stat.size,
			contentLength: stat.size,
			mimeType,
			contentType: mimeType,
			lastModified: stat.mtime,
			etag: `W/"${etagBody}"`,
			visibility: await this.#readVisibility(filePath),
		};
	}

	async getVisibility(filePath: string): Promise<Visibility> {
		return this.#readVisibility(filePath);
	}

	async setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		const full = await this.#safePath(filePath);
		if (!(await exists(full))) {
			throw Object.assign(
				new E_ARCHIVE_NOT_FOUND([
					`Cannot set visibility — file does not exist at path '${filePath}'`,
				]),
				{ help: "put() the file before calling setVisibility()." },
			);
		}
		// On a private disk the object stays private (flydrive's FS driver
		// ignores `setVisibility` altogether).
		await this.#writeMarker(full, this.#intended(visibility) ?? visibility);
	}

	/**
	 * Read the sidecar marker.
	 *   - Private disk → `'private'` for every key, marker or not (flydrive's
	 *     FS driver answers its disk option for every key).
	 *   - Missing sidecar → `'public'`, the public disk's default.
	 *   - Corrupted sidecar (unreadable file / malformed JSON) → THROW. A
	 *     silent fallback to `'public'` would turn any disk corruption or I/O
	 *     blip into a private→public downgrade for an existing private file.
	 *     Refuse to serve undetermined visibility instead.
	 */
	async #readVisibility(filePath: string): Promise<Visibility> {
		const sidecar =
			(await this.#safePath(filePath)) + VISIBILITY_SIDECAR_SUFFIX;
		if (this.#visibility === "private") return "private";
		let raw: string;
		try {
			raw = await fsp.readFile(sidecar, "utf8");
		} catch (err) {
			// Absent sidecar is the documented default, and it is the common
			// case: one syscall answers both that and a real read failure.
			if (errnoCode(err) === "ENOENT") return "public";
			throw Object.assign(
				new E_ARCHIVE_VISIBILITY_CORRUPT([
					`Failed to read visibility sidecar for '${filePath}' (${errnoCode(err) ?? "I/O error"}); refusing to default to 'public'.`,
				]),
				{
					help: "Inspect the sidecar file or re-apply visibility via setVisibility().",
				},
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw Object.assign(
				new E_ARCHIVE_VISIBILITY_CORRUPT([
					`Sidecar for '${filePath}' is not valid JSON; refusing to default to 'public'.`,
				]),
				{
					help: "Delete the sidecar file and re-apply visibility via setVisibility().",
				},
			);
		}
		// Fail CLOSED on anything that is not exactly one of the two values.
		//
		// `=== "private" ? "private" : "public"` treated every other input as
		// public, so a sidecar holding `{}`, `{"visibility":"PRIVATE"}` or a
		// truncated write silently downgraded a private file — `url()` then
		// handed out `/storage/<path>` instead of a signed URL. The doc comment
		// above already promised this for unparseable JSON; a JSON document
		// that parses and says nothing usable is the same situation.
		const visibility =
			typeof parsed === "object" && parsed !== null && "visibility" in parsed
				? parsed.visibility
				: undefined;
		if (visibility === "private" || visibility === "public") {
			return visibility;
		}
		throw Object.assign(
			new E_ARCHIVE_VISIBILITY_CORRUPT([
				`Sidecar for '${filePath}' carries no usable visibility (${JSON.stringify(visibility)}); refusing to default to 'public'.`,
			]),
			{
				help: "Delete the sidecar file and re-apply visibility via setVisibility().",
			},
		);
	}

	getSignedUrl(filePath: string, options?: SignedUrlOptions): string {
		// Fail fast on unsafe paths instead of producing a signed URL that
		// can never be served — `storage.get()` would reject it later via
		// `#safePath`, but signing-time errors are easier to diagnose.
		//
		// The lexical half only: this method is synchronous in the driver
		// contract and cannot await the symlink walk. Nothing is lost, because
		// signing a URL reads no file — the read it leads to goes through the
		// full check. What must NOT be skipped here is the control-character
		// rejection, since `\n` is this signature's own payload separator, and
		// `#lexicalPath` is where that lives. What is signed is the
		// normalised key, which is what the route recomputes it over.
		this.#lexicalPath(filePath);
		const key = this.#key(filePath);
		const expiresIn = parseExpiry(options?.expiresIn ?? DEFAULT_EXPIRES_IN);
		assertValidExpiry(expiresIn);
		const secret = this.#signingSecret;
		if (secret === null) {
			throw Object.assign(
				new E_ARCHIVE_SIGNING_DISABLED([
					"LocalDriver.getSignedUrl requires a signingSecret at construction time",
				]),
				{
					help: "Pass { signingSecret: <hex or random string> } to the LocalDriver constructor, or set config.archive.local.signingSecret. Private files require a signing secret.",
				},
			);
		}
		const exp = Math.floor(Date.now() / 1000) + expiresIn;
		// Newline-delimited payload: a filePath cannot forge `exp` by
		// embedding `&exp=...` in its own bytes (URL-decoding still
		// keeps the literal `\n` separator in the signed material).
		// Response-header overrides are signed with the rest and carried in the
		// query, where the signed route reads, verifies and emits them.
		const overrides = requestedOverrides(options ?? {});
		// The served path is signed, route base path included, as upstream
		// signs the whole route URL: two disks sharing a secret do not accept
		// each other's URLs.
		const message = signedPayload(
			servedPath(this.#routeBasePath, key),
			exp,
			overrides,
		);
		const sig = createHmac("sha256", secret).update(message).digest("hex");
		const url = `${this.publicUrl(key)}?exp=${exp}&sig=${sig}`;
		return overrides.length === 0 ? url : `${url}&${overrideQuery(overrides)}`;
	}

	/**
	 * The LocalDriver serves uploads through the app (not a presigned
	 * PUT to an object store), so there is no presigned-upload URL to
	 * hand out. Fail loudly rather than return an unusable value.
	 */
	getSignedUploadUrl(_filePath: string, _options?: SignedUrlOptions): string {
		throw new E_ARCHIVE_SIGNED_UPLOAD_UNSUPPORTED();
	}

	/**
	 * @internal Used by the signed-route middleware to re-compute the
	 * HMAC server-side. Not part of the public `StorageDriver` contract.
	 */
	getSigningSecret(): string | null {
		return this.#signingSecret;
	}

	async copy(from: string, to: string, options?: WriteOptions): Promise<void> {
		const fromFull = await this.#safePath(from);
		const toFull = await this.#safePath(to);
		if (!(await exists(fromFull))) {
			throw Object.assign(
				new E_ARCHIVE_NOT_FOUND([
					`Cannot copy — source does not exist at path '${from}'`,
				]),
				{ help: "Confirm the source path was put() first." },
			);
		}
		// The copy takes the source's visibility unless the caller asks
		// otherwise, as flydrive's S3 and GCS drivers do: left to the default,
		// the copy of a private file was public and served unsigned. Read
		// before anything is written, so a damaged source marker throws first.
		const target = this.#intended(
			options?.visibility ?? (await this.#ownVisibility(from, fromFull)),
		);
		await fsp.mkdir(path.dirname(toFull), { recursive: true });
		// A private one is marked before the bytes are copied, as put() does.
		await this.#writeMarked(toFull, target, () =>
			copyNoFollow(fromFull, toFull),
		);
	}

	/**
	 * The visibility the marker of the file at `full` states, or `undefined`
	 * when it has none. A damaged marker throws.
	 */
	async #ownVisibility(
		filePath: string,
		full: string,
	): Promise<Visibility | undefined> {
		return (await exists(full + VISIBILITY_SIDECAR_SUFFIX))
			? this.#readVisibility(filePath)
			: undefined;
	}

	async move(from: string, to: string, options?: WriteOptions): Promise<void> {
		const fromFull = await this.#safePath(from);
		const toFull = await this.#safePath(to);
		if (!(await exists(fromFull))) {
			throw Object.assign(
				new E_ARCHIVE_NOT_FOUND([
					`Cannot move — source does not exist at path '${from}'`,
				]),
				{ help: "Confirm the source path was put() first." },
			);
		}
		// Capture source visibility BEFORE the main move. Re-writing the new
		// sidecar from captured data (instead of renaming the source sidecar)
		// is robust against EXDEV/permission errors that would otherwise
		// silently downgrade private→public. `#readVisibility` throws on
		// corruption, which surfaces here BEFORE we mutate anything.
		const fromSidecar = fromFull + VISIBILITY_SIDECAR_SUFFIX;
		const capturedVisibility = await this.#ownVisibility(from, fromFull);
		// An explicit visibility override wins over the preserved value.
		const target = this.#intended(options?.visibility ?? capturedVisibility);
		await fsp.mkdir(path.dirname(toFull), { recursive: true });
		// A private target is marked BEFORE the file arrives: renamed first, the
		// moved private file sat at the target with no marker — public — until
		// the second write, and for good when that write failed.
		const previous =
			target === "private" ? await this.#markPrivate(toFull) : undefined;
		try {
			await fsp.rename(fromFull, toFull);
		} catch (err) {
			if (errnoCode(err) !== "EXDEV") {
				// Nothing moved: the target is what it was, so is its marker.
				if (previous !== undefined) await restoreMarker(toFull, previous);
				throw err;
			}
			// Cross-device rename — fall back to copy+unlink. A half-copied
			// target is removed, and its marker only once the data is gone.
			// Copied through descriptors, as copy() is: `copyFile` followed a
			// dangling link planted at the target out of the root.
			try {
				await copyNoFollow(fromFull, toFull);
			} catch (copyErr) {
				await discardPrivate(toFull);
				throw copyErr;
			}
			await fsp.unlink(fromFull);
		}
		// A public target is marked AFTER the move: until then, whatever was at
		// the target keeps its own marker. Public is the default, so an absent
		// source sidecar and no override mean no work.
		if (target === "public") {
			try {
				await this.#writeMarker(toFull, target);
			} catch (err) {
				throw new E_ARCHIVE_VISIBILITY_MOVE_FAILED([
					from,
					to,
					errnoCode(err) ?? "unknown",
				]);
			}
		}
		if (capturedVisibility !== undefined) {
			// Best-effort cleanup of the source sidecar — visibility is already
			// preserved on the target side. A failure here leaves a stale
			// sidecar pointing at the now-missing source file; benign.
			try {
				await fsp.unlink(fromSidecar);
			} catch {
				// benign — source dir may be cleaned up by later operations.
			}
		}
	}

	async deleteAll(prefix: string): Promise<void> {
		// Walk the existing listing (already sidecar-aware + safe) and
		// remove every match. delete() also drops each file's sidecar.
		const normalized = normalizePrefix(prefix);
		const paths: string[] = [];
		for await (const entry of this.list(normalized)) {
			paths.push(entry.path);
		}
		for (const p of paths) {
			await this.delete(p);
		}
		// Prune the prefix directory itself when it is now empty, mirroring
		// flydrive's "the folder is deleted" behaviour. Best-effort.
		if (normalized !== "") {
			const dir = await this.#safePath(normalized);
			try {
				const stat = await fsp.stat(dir);
				if (stat.isDirectory() && (await fsp.readdir(dir)).length === 0) {
					await fsp.rmdir(dir);
				}
			} catch {
				// benign — leave non-empty / vanished dirs alone.
			}
		}
	}

	async listAll(
		prefix: string,
		options?: ListAllOptions,
	): Promise<ListAllResult> {
		const recursive = options?.recursive ?? false;
		const files: DriveFile[] = [];
		const directories = new Map<string, DriveDirectory>();
		// A directory prefix (`users/1/`), or `""` for the root.
		const normalizedPrefix = normalizePrefix(prefix);
		for await (const entry of this.list(normalizedPrefix)) {
			if (recursive) {
				files.push(
					new DriveFile(entry.path, this, await this.#entryMetadata(entry)),
				);
				continue;
			}
			// Non-recursive: collapse anything below the immediate level
			// into a DriveDirectory marker.
			const rest = entry.path.slice(normalizedPrefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) {
				files.push(
					new DriveFile(entry.path, this, await this.#entryMetadata(entry)),
				);
			} else {
				const dirPrefix = normalizedPrefix + rest.slice(0, slash);
				if (!directories.has(dirPrefix)) {
					directories.set(dirPrefix, new DriveDirectory(dirPrefix));
				}
			}
		}
		// Sorted by key, as upstream lists: the walk's order is the
		// filesystem's, which differs between machines.
		files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		return { objects: [...directories.values(), ...files] };
	}

	/** Build a metadata snapshot from a cheap `list()` entry (no extra stat). */
	async #entryMetadata(entry: StorageEntry): Promise<Metadata> {
		const mimeType = inferMimeType(path.extname(entry.path).toLowerCase());
		return {
			size: entry.size,
			contentLength: entry.size,
			mimeType,
			contentType: mimeType,
			lastModified: entry.lastModified,
			etag: "",
			visibility: await this.#readVisibility(entry.path),
		};
	}

	async *list(given: string): AsyncIterable<StorageEntry> {
		const prefix = normalizePrefix(given);
		// Start the walk at the deepest directory the prefix names, not at the
		// root: `avatars/42` (normalised to `avatars/42/`) reads `avatars/42`.
		// Walking the whole root and filtering afterwards cost the
		// size of the entire disk for every listing, however narrow.
		const slash = prefix.lastIndexOf("/");
		const dir = slash === -1 ? "" : prefix.slice(0, slash);
		const start = dir === "" ? this.#root : await this.#safePath(dir);
		let walk: fs.Dir;
		try {
			// Read lazily: entries arrive as the walk reaches them instead of
			// the whole subtree being held in memory first. Links are listed,
			// not followed, so the walk stays inside the root.
			walk = await fsp.opendir(start, { recursive: true });
		} catch (err) {
			const code = errnoCode(err);
			// Nothing stored under that prefix, or it names a file.
			if (code === "ENOENT" || code === "ENOTDIR") return;
			throw err;
		}
		for await (const entry of walk) {
			if (!entry.isFile()) continue;
			const full = path.join(entry.parentPath, entry.name);
			const rel = path.relative(this.#root, full).split(path.sep).join("/");
			// Exclude sidecars — implementation detail.
			if (rel.toLowerCase().endsWith(VISIBILITY_SIDECAR_SUFFIX)) continue;
			if (!rel.startsWith(prefix)) continue;
			const stat = await fsp.stat(full);
			yield { path: rel, size: stat.size, lastModified: stat.mtime };
		}
	}
}

/**
 * What a visibility marker held before a write replaced it, so a write that
 * fails can put it back. `unknown` — a marker that could not be read, a link
 * planted at its name — is never touched again.
 */
type MarkerSnapshot =
	| { readonly state: "absent" }
	| { readonly state: "present"; readonly bytes: Buffer }
	| { readonly state: "unknown" };

/** The marker of the file at `full` as it is now. */
async function markerSnapshot(full: string): Promise<MarkerSnapshot> {
	try {
		const handle = await fsp.open(
			full + VISIBILITY_SIDECAR_SUFFIX,
			fs.constants.O_RDONLY | O_NOFOLLOW,
		);
		try {
			return { state: "present", bytes: await handle.readFile() };
		} finally {
			await handle.close();
		}
	} catch (err) {
		return errnoCode(err) === "ENOENT"
			? { state: "absent" }
			: { state: "unknown" };
	}
}

/**
 * Put back the marker `snapshot` recorded. Best-effort, never throws: it runs
 * on a path that is already failing, and a restore that fails leaves the
 * private marker (or a damaged one, read as undetermined) — closed either way.
 */
async function restoreMarker(
	full: string,
	snapshot: MarkerSnapshot,
): Promise<void> {
	const marker = full + VISIBILITY_SIDECAR_SUFFIX;
	try {
		if (snapshot.state === "absent") {
			await fsp.unlink(marker);
		} else if (snapshot.state === "present") {
			const handle = await fsp.open(
				marker,
				fs.constants.O_WRONLY | fs.constants.O_TRUNC | O_NOFOLLOW,
			);
			try {
				await handle.writeFile(snapshot.bytes);
			} finally {
				await handle.close();
			}
		}
	} catch {
		// Closed either way — see above.
	}
}

/**
 * Remove a private object whose data write failed half-way: the data first,
 * then its marker — only once the data is gone, so the bytes are never left
 * without the marker that keeps them private. Never throws.
 */
async function discardPrivate(full: string): Promise<void> {
	try {
		await fsp.unlink(full);
	} catch (err) {
		if (errnoCode(err) !== "ENOENT") return;
	}
	try {
		await fsp.unlink(full + VISIBILITY_SIDECAR_SUFFIX);
	} catch {
		// An orphan marker serves nothing.
	}
}

/**
 * Copy the file at `from` to `to`, two paths `#safePath` resolved, through
 * descriptors opened with O_NOFOLLOW at both ends.
 *
 * `copyFile` opens its target by name and follows a link: `#safePath` cannot
 * see a DANGLING link (its realpath fails, the walk checks the parent), so a
 * link planted at the target made a copy create its target outside the root.
 * The source is opened the same way, so a link swapped in there after the
 * check is not read into the disk.
 */
/** Bytes read and written per step of {@link copyNoFollow}. */
const COPY_CHUNK = 64 * 1024;

async function copyNoFollow(from: string, to: string): Promise<void> {
	const source = await fsp.open(from, fs.constants.O_RDONLY | O_NOFOLLOW);
	try {
		// Not truncated at open: when both names are one file, truncating
		// would empty the source before it is read.
		const target = await fsp.open(
			to,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | O_NOFOLLOW,
			0o666,
		);
		try {
			const [read, written] = await Promise.all([source.stat(), target.stat()]);
			// The same key, or a hard link to the source: nothing to copy.
			if (read.dev === written.dev && read.ino === written.ino) return;
			await target.truncate(0);
			// Chunk by chunk through the two descriptors, which this function
			// owns and closes: a stream made from a handle closes it itself.
			const chunk = Buffer.allocUnsafe(COPY_CHUNK);
			let position = 0;
			for (;;) {
				const { bytesRead } = await source.read(
					chunk,
					0,
					chunk.length,
					position,
				);
				if (bytesRead === 0) return;
				let written = 0;
				while (written < bytesRead) {
					const { bytesWritten } = await target.write(
						chunk,
						written,
						bytesRead - written,
						position + written,
					);
					written += bytesWritten;
				}
				position += bytesRead;
			}
		} finally {
			await target.close();
		}
	} finally {
		await source.close();
	}
}

/**
 * Whether a path exists, without `existsSync` blocking the event loop.
 *
 * Used only where the answer is genuinely needed on its own; where a read or
 * unlink follows, the operation's own ENOENT answers it in one syscall and
 * without the window between the two.
 */
async function exists(target: string): Promise<boolean> {
	try {
		await fsp.access(target);
		return true;
	} catch {
		return false;
	}
}

/** A local path, given either plainly or as a `file:` URL. */
function localPath(source: string | URL): string {
	return source instanceof URL ? url.fileURLToPath(source) : source;
}

/**
 * The disk an application talks to: one driver behind it, and every key
 * normalised (see `keys.ts`) before that driver sees it, whatever the driver.
 *
 * As the storage library's disk does, each operation wraps a driver failure in
 * its own error — `E_CANNOT_WRITE_FILE`, `E_CANNOT_READ_FILE`, … — with the
 * driver's error (`E_ARCHIVE_NOT_FOUND`, `E_ARCHIVE_REMOTE_FAILED`, an errno
 * error) as `cause`. A refused key keeps its own code; `list` / `listAll` are
 * not wrapped, as upstream does not wrap `listAll`.
 */
export class StorageManager {
	#driver: StorageDriver;

	constructor(driver: StorageDriver) {
		this.#driver = driver;
	}

	async put(
		filePath: string,
		content: Buffer | string,
		options?: WriteOptions,
	): Promise<void> {
		const key = normalizeKey(filePath);
		return wrapFailure(
			() => this.#driver.put(key, content, options),
			(cause) => new E_CANNOT_WRITE_FILE([key], { cause }),
		);
	}

	/**
	 * A handle on one object, without reading it (flydrive `file`).
	 *
	 *   const avatar = disk.file(`avatars/${user.id}.png`)
	 *   if (await avatar.exists()) return avatar.getUrl()
	 *
	 * Nothing is fetched until a method on the handle asks for it.
	 */
	file(key: string): DriveFile {
		return new DriveFile(key, this.#driver);
	}

	/**
	 * Rebuild a handle from a stored snapshot (flydrive `fromSnapshot`), so a
	 * name and a size can be rendered without asking the provider again.
	 */
	fromSnapshot(snapshot: FileSnapshot): DriveFile {
		return new DriveFile(snapshot.key, this.#driver, {
			size: snapshot.contentLength,
			contentLength: snapshot.contentLength,
			mimeType: snapshot.contentType ?? "application/octet-stream",
			contentType: snapshot.contentType ?? "application/octet-stream",
			lastModified: new Date(snapshot.lastModified),
			etag: snapshot.etag,
			// A snapshot does not carry visibility. Assume private: guessing
			// "public" for a file whose access we do not know is the one error
			// with a consequence.
			visibility: "private",
		});
	}

	/**
	 * Copy a file from the LOCAL filesystem into this disk.
	 *
	 * The one to reach for after an upload: the request left a file in a temp
	 * directory and it has to reach the bucket. `copy()` moves within the disk
	 * and cannot see the local path at all when the disk is remote.
	 */
	async copyFromFs(
		source: string | URL,
		destination: string,
		options?: WriteOptions,
	): Promise<void> {
		// Before the source is opened: a destination that is not a valid key
		// is refused without a descriptor to clean up.
		const key = normalizeKey(destination);
		const stream = fs.createReadStream(localPath(source));
		try {
			await this.#driver.putStream(key, stream, options);
		} catch (error) {
			// The driver can reject BEFORE reading a byte — a destination outside
			// the disk is rejected up front. The stream is then never consumed:
			// it holds its file descriptor open, and later emits `error` with no
			// listener attached, which crashes the process rather than surfacing
			// as this rejection.
			//
			// The listener goes on BEFORE destroy: the open() is already in flight
			// and will report ENOENT/EACCES on a stream nobody is reading. We are
			// discarding it, and the driver's rejection below is the error that
			// actually explains the failure.
			stream.on("error", () => {});
			stream.destroy();
			throw isKeyRefusal(error)
				? error
				: new E_CANNOT_WRITE_FILE([key], { cause: error });
		}
	}

	/**
	 * Move a file from the LOCAL filesystem into this disk, removing the source.
	 *
	 * The source is deleted only after the write succeeded — a failed upload
	 * that also destroyed the only copy is not a trade anyone would take.
	 */
	async moveFromFs(
		source: string | URL,
		destination: string,
		options?: WriteOptions,
	): Promise<void> {
		const from = localPath(source);
		await this.copyFromFs(from, destination, options);
		await fs.promises.unlink(from);
	}

	async putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		options?: PutStreamOptions,
	): Promise<void> {
		const key = normalizeKey(filePath);
		return wrapFailure(
			() => this.#driver.putStream(key, readable, options),
			(cause) => new E_CANNOT_WRITE_FILE([key], { cause }),
		);
	}

	/** Contents, `null` when absent; any failure is `E_CANNOT_READ_FILE`. */
	async get(filePath: string): Promise<Buffer | null> {
		return this.file(filePath).get();
	}

	/**
	 * Contents as a `Uint8Array`. An absent object is `E_CANNOT_READ_FILE`,
	 * with `E_ARCHIVE_NOT_FOUND` as its `cause`.
	 */
	async getBytes(filePath: string): Promise<Uint8Array> {
		return this.file(filePath).getBytes();
	}

	/** @deprecated AdonisJS Drive alias — use {@link StorageManager.getBytes}. */
	async getArrayBuffer(filePath: string): Promise<Uint8Array> {
		return this.file(filePath).getBytes();
	}

	async getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		return this.file(filePath).getStream();
	}

	async delete(filePath: string): Promise<boolean> {
		const key = normalizeKey(filePath);
		return wrapFailure(
			() => this.#driver.delete(key),
			(cause) => new E_CANNOT_DELETE_FILE([key], { cause }),
		);
	}

	async exists(filePath: string): Promise<boolean> {
		return this.file(filePath).exists();
	}

	async url(filePath: string): Promise<string> {
		return this.file(filePath).getUrl();
	}

	/** AdonisJS Drive name for {@link url}. */
	async getUrl(filePath: string): Promise<string> {
		return this.file(filePath).getUrl();
	}

	publicUrl(filePath: string): string {
		const key = normalizeKey(filePath);
		try {
			return this.#driver.publicUrl(key);
		} catch (error) {
			throw isKeyRefusal(error)
				? error
				: new E_CANNOT_GENERATE_URL([key], { cause: error });
		}
	}

	getSignedUrl(
		filePath: string,
		options?: SignedUrlOptions,
	): string | Promise<string> {
		return this.file(filePath).getSignedUrl(options);
	}

	getSignedUploadUrl(
		filePath: string,
		options?: SignedUrlOptions,
	): string | Promise<string> {
		return this.file(filePath).getSignedUploadUrl(options);
	}

	async getMetadata(filePath: string): Promise<Metadata> {
		return this.file(filePath).getMetaData();
	}

	/** AdonisJS Drive casing for {@link getMetadata}. */
	async getMetaData(filePath: string): Promise<Metadata> {
		return this.file(filePath).getMetaData();
	}

	async getVisibility(filePath: string): Promise<Visibility> {
		return this.file(filePath).getVisibility();
	}

	async setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		const key = normalizeKey(filePath);
		return wrapFailure(
			() => this.#driver.setVisibility(key, visibility),
			(cause) => new E_CANNOT_SET_VISIBILITY([key], { cause }),
		);
	}

	async copy(from: string, to: string, options?: WriteOptions): Promise<void> {
		const source = normalizeKey(from);
		const destination = normalizeKey(to);
		return wrapFailure(
			() => this.#driver.copy(source, destination, options),
			(cause) => new E_CANNOT_COPY_FILE([source, destination], { cause }),
		);
	}

	async move(from: string, to: string, options?: WriteOptions): Promise<void> {
		const source = normalizeKey(from);
		const destination = normalizeKey(to);
		return wrapFailure(
			() => this.#driver.move(source, destination, options),
			(cause) => new E_CANNOT_MOVE_FILE([source, destination], { cause }),
		);
	}

	async deleteAll(prefix: string): Promise<void> {
		const normalized = normalizePrefix(prefix);
		return wrapFailure(
			() => this.#driver.deleteAll(normalized),
			// The root reads as "/", the way the library names it.
			(cause) =>
				new E_CANNOT_DELETE_DIRECTORY([normalized === "" ? "/" : normalized], {
					cause,
				}),
		);
	}

	list(prefix: string): AsyncIterable<StorageEntry> {
		// Validated now, not on the first iteration: a refused prefix is the
		// caller's mistake and should surface where the call was made.
		return this.#driver.list(normalizePrefix(prefix));
	}

	/** AdonisJS Drive `listAll` — paged {@link DriveFile}/{@link DriveDirectory}. */
	async listAll(
		prefix: string,
		options?: ListAllOptions,
	): Promise<ListAllResult> {
		return this.#driver.listAll(normalizePrefix(prefix), options);
	}
}
