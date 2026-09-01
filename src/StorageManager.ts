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
import { ArchiveError } from "./errors.js";
import {
	assertValidExpiry,
	DEFAULT_EXPIRES_IN,
	parseExpiry,
} from "./expiry.js";
import { inferMimeType } from "./mime-types.js";
import { DriveDirectory, DriveFile, type FileSnapshot } from "./objects.js";

export { DriveDirectory, DriveFile } from "./objects.js";

/** Options for {@link StorageDriver.getSignedUrl}. */
export interface SignedUrlOptions {
	/**
	 * URL lifetime. Either a number of seconds or an AdonisJS-style
	 * duration string (`'30mins'`, `'7 days'`, `'1h'`). Default: 300
	 * (5 minutes). Bounds after parsing: 1–604800.
	 */
	expiresIn?: number | string;
	/** Sets the response `Content-Type` served with the signed URL (cloud drivers). */
	contentType?: string;
	/** Sets the response `Content-Disposition` served with the signed URL (cloud drivers). */
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
	/** Public/private visibility. Missing-sidecar on Local = `'public'`. */
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
	 * Resolve object metadata. Throws `ArchiveError('E_ARCHIVE_NOT_FOUND', ...)`
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
	 * missing. Target is overwritten if it exists. Visibility is NOT
	 * carried over unless `options.visibility` is passed — the new object
	 * takes default visibility.
	 */
	copy(from: string, to: string, options?: WriteOptions): Promise<void>;
	/**
	 * Relocate an object. Equivalent to `copy` + `delete` on cloud
	 * drivers (non-atomic between the two steps); atomic `rename` on
	 * Local. Visibility IS preserved because identity is preserved.
	 */
	move(from: string, to: string, options?: WriteOptions): Promise<void>;
	/**
	 * Delete every object whose path starts with `prefix`. Local removes
	 * the matching files (and prunes emptied directories); S3 batch-deletes;
	 * GCS deletes per object. AdonisJS Drive parity.
	 */
	deleteAll(prefix: string): Promise<void>;
	/**
	 * Yield one {@link StorageEntry} per object whose path starts with
	 * `prefix`. Pagination (S3/GCS) and filesystem walk (Local) happen
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
	 */
	signingSecret?: string;
}

export class LocalDriver implements StorageDriver {
	#root: string;
	#signingSecret: string | null;

	/**
	 * The only synchronous filesystem access left in this driver, and the only
	 * one that cannot be anything else: a constructor cannot await. It runs
	 * once, at boot, before the server is serving. Every method below is
	 * asynchronous — they used to be async signatures over `writeFileSync` /
	 * `readFileSync`, so a large upload or download stalled every other
	 * request in the process for its whole duration.
	 */
	constructor(root: string, options?: LocalDriverOptions) {
		const resolved = path.resolve(root);
		if (!fs.existsSync(resolved)) {
			fs.mkdirSync(resolved, { recursive: true });
		}
		// Canonicalise the root once so subsequent realpath-based
		// escape checks compare apples to apples.
		this.#root = fs.realpathSync(resolved);
		const secret = options?.signingSecret;
		if (secret !== undefined) {
			// Empty or trivially short secrets defeat the whole point of
			// HMAC signing. 16 bytes is the floor: rejects obviously weak
			// values without being annoyingly strict about format.
			if (typeof secret !== "string" || secret.length < 16) {
				throw new ArchiveError(
					"E_ARCHIVE_WEAK_SIGNING_SECRET",
					`LocalDriver signingSecret must be a string of at least 16 chars (got length ${typeof secret === "string" ? secret.length : "non-string"})`,
					{
						hint: "Use a cryptographically random secret, e.g. `crypto.randomBytes(32).toString('hex')`.",
					},
				);
			}
		}
		this.#signingSecret = secret ?? null;
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
		// Reject control chars that would smuggle HMAC delimiters or
		// confuse path handling. `\n` (10) is the signing payload
		// separator — a filename containing `\n` could otherwise forge
		// `exp`. `\r` (13) and NUL (0) round out the trio.
		for (let i = 0; i < filePath.length; i++) {
			const code = filePath.charCodeAt(i);
			if (code === 0 || code === 10 || code === 13) {
				throw new Error(
					"Invalid filePath: control characters (NUL, LF, CR) are not allowed",
				);
			}
		}
		const full = path.resolve(this.#root, filePath);
		// Lexical guard — cheap and covers the `..` case.
		if (!full.startsWith(this.#root + path.sep) && full !== this.#root) {
			throw new Error(
				`Path traversal blocked: '${filePath}' resolves outside storage root`,
			);
		}
		return full;
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
					throw new Error(
						`Path traversal blocked: '${filePath}' resolves outside storage root via symlink`,
					);
				}
				return full;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
		await fsp.writeFile(full, content);
		// Only `visibility` has a filesystem-equivalent (the sidecar).
		// contentType/cacheControl/... have no local meaning.
		if (options?.visibility !== undefined) {
			await this.setVisibility(filePath, options.visibility);
		}
	}

	async getBytes(filePath: string): Promise<Uint8Array> {
		const buf = await this.get(filePath);
		if (buf === null) {
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`File does not exist at path '${filePath}'`,
				{ hint: "Confirm the path and that the file was put() first." },
			);
		}
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	async putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		// LocalDriver ignores contentType (inferred from extension via
		// getMetadata) and contentLength (FS knows its own size).
		_options?: PutStreamOptions,
	): Promise<void> {
		const full = await this.#safePath(filePath);
		await fsp.mkdir(path.dirname(full), { recursive: true });
		// `pipeline` propagates errors and destroys the write target on
		// failure — no manual cleanup needed.
		await pipeline(readable, fs.createWriteStream(full));
	}

	async get(filePath: string): Promise<Buffer | null> {
		const full = await this.#safePath(filePath);
		try {
			return await fsp.readFile(full);
		} catch (err) {
			// One syscall instead of exists-then-read: the pair also answered
			// `null` for a file that was deleted between the two.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		const full = await this.#safePath(filePath);
		if (!(await exists(full))) {
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`File does not exist at path '${filePath}'`,
				{ hint: "Confirm the path and that the file was put() first." },
			);
		}
		return fs.createReadStream(full);
	}

	async delete(filePath: string): Promise<boolean> {
		const full = await this.#safePath(filePath);
		try {
			await fsp.unlink(full);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
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
		// Sidecars are an implementation detail — pretend they don't
		// exist from the public API's point of view.
		if (filePath.endsWith(VISIBILITY_SIDECAR_SUFFIX)) return false;
		return exists(await this.#safePath(filePath));
	}

	publicUrl(filePath: string): string {
		// Encode each segment so special chars (`?`, `#`, spaces, unicode)
		// survive the trip through an HTTP layer. The middleware mirrors
		// this by decoding each segment before recomputing the HMAC —
		// skipping encoding here would leave the URL unparseable.
		const encoded = filePath
			.split("/")
			.map((seg) => encodeURIComponent(seg))
			.join("/");
		return `/storage/${encoded}`;
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
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ArchiveError(
					"E_ARCHIVE_NOT_FOUND",
					`File does not exist at path '${filePath}'`,
					{ hint: "Confirm the path and that the file was put() first." },
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
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`Cannot set visibility — file does not exist at path '${filePath}'`,
				{ hint: "put() the file before calling setVisibility()." },
			);
		}
		const sidecar = full + VISIBILITY_SIDECAR_SUFFIX;
		await fsp.writeFile(sidecar, JSON.stringify({ visibility }), { flag: "w" });
	}

	/**
	 * Read the sidecar marker.
	 *   - Missing sidecar → `'public'` (the documented default; sidecar is only
	 *     written when `setVisibility('private')` was explicitly called).
	 *   - Corrupted sidecar (unreadable file / malformed JSON) → THROW. A
	 *     silent fallback to `'public'` would turn any disk corruption or I/O
	 *     blip into a private→public downgrade for an existing private file.
	 *     Refuse to serve undetermined visibility instead.
	 */
	async #readVisibility(filePath: string): Promise<Visibility> {
		const sidecar =
			(await this.#safePath(filePath)) + VISIBILITY_SIDECAR_SUFFIX;
		let raw: string;
		try {
			raw = await fsp.readFile(sidecar, "utf8");
		} catch (err) {
			// Absent sidecar is the documented default, and it is the common
			// case: one syscall answers both that and a real read failure.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return "public";
			throw new ArchiveError(
				"E_ARCHIVE_VISIBILITY_CORRUPT",
				`Failed to read visibility sidecar for '${filePath}' (${(err as NodeJS.ErrnoException).code ?? "I/O error"}); refusing to default to 'public'.`,
				{
					hint: "Inspect the sidecar file or re-apply visibility via setVisibility().",
				},
			);
		}
		let parsed: { visibility?: unknown };
		try {
			parsed = JSON.parse(raw) as { visibility?: unknown };
		} catch {
			throw new ArchiveError(
				"E_ARCHIVE_VISIBILITY_CORRUPT",
				`Sidecar for '${filePath}' is not valid JSON; refusing to default to 'public'.`,
				{
					hint: "Delete the sidecar file and re-apply visibility via setVisibility().",
				},
			);
		}
		return parsed.visibility === "private" ? "private" : "public";
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
		// `#lexicalPath` is where that lives.
		this.#lexicalPath(filePath);
		const expiresIn = parseExpiry(options?.expiresIn ?? DEFAULT_EXPIRES_IN);
		assertValidExpiry(expiresIn);
		const secret = this.#signingSecret;
		if (secret === null) {
			throw new ArchiveError(
				"E_ARCHIVE_SIGNING_DISABLED",
				"LocalDriver.getSignedUrl requires a signingSecret at construction time",
				{
					hint: "Pass { signingSecret: <hex or random string> } to the LocalDriver constructor, or set config.archive.local.signingSecret. Private files require a signing secret.",
				},
			);
		}
		const exp = Math.floor(Date.now() / 1000) + expiresIn;
		// Newline-delimited payload: a filePath cannot forge `exp` by
		// embedding `&exp=...` in its own bytes (URL-decoding still
		// keeps the literal `\n` separator in the signed material).
		const message = `${filePath}\n${exp}`;
		const sig = createHmac("sha256", secret).update(message).digest("hex");
		return `${this.publicUrl(filePath)}?exp=${exp}&sig=${sig}`;
	}

	/**
	 * The LocalDriver serves uploads through the app (not a presigned
	 * PUT to an object store), so there is no presigned-upload URL to
	 * hand out. Fail loudly rather than return an unusable value.
	 */
	getSignedUploadUrl(_filePath: string, _options?: SignedUrlOptions): string {
		throw new ArchiveError(
			"E_ARCHIVE_SIGNED_UPLOAD_UNSUPPORTED",
			"LocalDriver does not support presigned upload URLs",
			{
				hint: "Presigned uploads are an S3/GCS feature. For local storage, upload through your app's HTTP handler.",
			},
		);
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
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`Cannot copy — source does not exist at path '${from}'`,
				{ hint: "Confirm the source path was put() first." },
			);
		}
		await fsp.mkdir(path.dirname(toFull), { recursive: true });
		await fsp.copyFile(fromFull, toFull);
		// Intentionally do NOT copy the visibility sidecar — new object
		// takes default visibility unless the caller asks otherwise.
		if (options?.visibility !== undefined) {
			await this.setVisibility(to, options.visibility);
		}
	}

	async move(from: string, to: string, options?: WriteOptions): Promise<void> {
		const fromFull = await this.#safePath(from);
		const toFull = await this.#safePath(to);
		if (!(await exists(fromFull))) {
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`Cannot move — source does not exist at path '${from}'`,
				{ hint: "Confirm the source path was put() first." },
			);
		}
		// Capture source visibility BEFORE the main move. Re-writing the new
		// sidecar from captured data (instead of renaming the source sidecar)
		// is robust against EXDEV/permission errors that would otherwise
		// silently downgrade private→public. `#readVisibility` throws on
		// corruption, which surfaces here BEFORE we mutate anything.
		const fromSidecar = fromFull + VISIBILITY_SIDECAR_SUFFIX;
		const toSidecar = toFull + VISIBILITY_SIDECAR_SUFFIX;
		const capturedVisibility: Visibility | undefined = (await exists(
			fromSidecar,
		))
			? await this.#readVisibility(from)
			: undefined;
		await fsp.mkdir(path.dirname(toFull), { recursive: true });
		try {
			await fsp.rename(fromFull, toFull);
		} catch (err) {
			// Cross-device rename — fall back to copy+unlink.
			if ((err as NodeJS.ErrnoException).code === "EXDEV") {
				await fsp.copyFile(fromFull, toFull);
				await fsp.unlink(fromFull);
			} else {
				throw err;
			}
		}
		// Visibility carries forward by re-writing the new sidecar from
		// captured data — atomic relative to the rename, immune to the
		// EXDEV/perm failure modes that plagued the rename-the-sidecar path.
		// Public is the default, so an absent source sidecar means no work.
		if (capturedVisibility !== undefined) {
			try {
				await fsp.writeFile(
					toSidecar,
					JSON.stringify({ visibility: capturedVisibility }),
					{ flag: "w" },
				);
			} catch (err) {
				throw new ArchiveError(
					"E_ARCHIVE_VISIBILITY_MOVE_FAILED",
					`move('${from}' -> '${to}'): main file moved but visibility sidecar write failed (${(err as NodeJS.ErrnoException).code ?? "unknown"}). Target visibility is undefined.`,
					{
						hint: "Re-apply visibility via setVisibility() on the target path.",
					},
				);
			}
			// Best-effort cleanup of the source sidecar — visibility is already
			// preserved on the target side. A failure here leaves a stale
			// sidecar pointing at the now-missing source file; benign.
			try {
				await fsp.unlink(fromSidecar);
			} catch {
				// benign — source dir may be cleaned up by later operations.
			}
		}
		// An explicit visibility override wins over the preserved value.
		if (options?.visibility !== undefined) {
			await this.setVisibility(to, options.visibility);
		}
	}

	async deleteAll(prefix: string): Promise<void> {
		// Walk the existing listing (already sidecar-aware + safe) and
		// remove every match. delete() also drops each file's sidecar.
		const paths: string[] = [];
		for await (const entry of this.list(prefix)) {
			paths.push(entry.path);
		}
		for (const p of paths) {
			await this.delete(p);
		}
		// Prune the prefix directory itself when it is now empty, mirroring
		// flydrive's "the folder is deleted" behaviour. Best-effort.
		const dir = await this.#safePath(prefix);
		if (dir !== this.#root) {
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
		const normalizedPrefix =
			prefix === "" || prefix === "/"
				? ""
				: prefix.endsWith("/")
					? prefix
					: `${prefix}/`;
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

	async *list(prefix: string): AsyncIterable<StorageEntry> {
		// `recursive: true` gives us every descendant in one call;
		// `withFileTypes: true` lets us skip directories and inspect each
		// entry without a follow-up stat for type.
		let entries: fs.Dirent[];
		try {
			entries = await fsp.readdir(this.#root, {
				recursive: true,
				withFileTypes: true,
			});
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			// `parentPath` is typed on Dirent since Node 20.12, which the engine
			// range already requires — the double cast that used to read it
			// (and its `path` fallback for older shapes) is no longer buying
			// anything.
			const parent = entry.parentPath ?? this.#root;
			const full = path.join(parent, entry.name);
			const rel = path.relative(this.#root, full).split(path.sep).join("/");
			// Exclude sidecars — implementation detail.
			if (rel.endsWith(VISIBILITY_SIDECAR_SUFFIX)) continue;
			if (!rel.startsWith(prefix)) continue;
			const stat = await fsp.stat(full);
			yield { path: rel, size: stat.size, lastModified: stat.mtime };
		}
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

export class StorageManager {
	#driver: StorageDriver;

	constructor(driver: StorageDriver) {
		this.#driver = driver;
	}

	put(
		filePath: string,
		content: Buffer | string,
		options?: WriteOptions,
	): Promise<void> {
		return this.#driver.put(filePath, content, options);
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
		const stream = fs.createReadStream(localPath(source));
		try {
			await this.#driver.putStream(destination, stream, options);
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
			throw error;
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

	putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		options?: PutStreamOptions,
	): Promise<void> {
		return this.#driver.putStream(filePath, readable, options);
	}

	get(filePath: string): Promise<Buffer | null> {
		return this.#driver.get(filePath);
	}

	/** Contents as a `Uint8Array`. Throws `E_ARCHIVE_NOT_FOUND` if absent. */
	getBytes(filePath: string): Promise<Uint8Array> {
		return this.#driver.getBytes(filePath);
	}

	/** @deprecated AdonisJS Drive alias — use {@link StorageManager.getBytes}. */
	getArrayBuffer(filePath: string): Promise<Uint8Array> {
		return this.#driver.getBytes(filePath);
	}

	getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		return this.#driver.getStream(filePath);
	}

	delete(filePath: string): Promise<boolean> {
		return this.#driver.delete(filePath);
	}

	exists(filePath: string): Promise<boolean> {
		return this.#driver.exists(filePath);
	}

	url(filePath: string): Promise<string> {
		return this.#driver.url(filePath);
	}

	/** AdonisJS Drive name for {@link url}. */
	getUrl(filePath: string): Promise<string> {
		return this.#driver.url(filePath);
	}

	publicUrl(filePath: string): string {
		return this.#driver.publicUrl(filePath);
	}

	getSignedUrl(
		filePath: string,
		options?: SignedUrlOptions,
	): string | Promise<string> {
		return this.#driver.getSignedUrl(filePath, options);
	}

	getSignedUploadUrl(
		filePath: string,
		options?: SignedUrlOptions,
	): string | Promise<string> {
		return this.#driver.getSignedUploadUrl(filePath, options);
	}

	getMetadata(filePath: string): Promise<Metadata> {
		return this.#driver.getMetadata(filePath);
	}

	/** AdonisJS Drive casing for {@link getMetadata}. */
	getMetaData(filePath: string): Promise<Metadata> {
		return this.#driver.getMetadata(filePath);
	}

	getVisibility(filePath: string): Promise<Visibility> {
		return this.#driver.getVisibility(filePath);
	}

	setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		return this.#driver.setVisibility(filePath, visibility);
	}

	copy(from: string, to: string, options?: WriteOptions): Promise<void> {
		return this.#driver.copy(from, to, options);
	}

	move(from: string, to: string, options?: WriteOptions): Promise<void> {
		return this.#driver.move(from, to, options);
	}

	deleteAll(prefix: string): Promise<void> {
		return this.#driver.deleteAll(prefix);
	}

	list(prefix: string): AsyncIterable<StorageEntry> {
		return this.#driver.list(prefix);
	}

	/** AdonisJS Drive `listAll` — paged {@link DriveFile}/{@link DriveDirectory}. */
	listAll(prefix: string, options?: ListAllOptions): Promise<ListAllResult> {
		return this.#driver.listAll(prefix, options);
	}
}
