/**
 * Storage — file storage abstraction with driver pattern.
 *
 * @implements MISS-24
 */

import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { ArchiveError } from "./errors.js";
import { assertValidExpiry, DEFAULT_EXPIRES_IN } from "./expiry.js";
import { inferMimeType } from "./mime-types.js";

/** Options for {@link StorageDriver.getSignedUrl}. */
export interface SignedUrlOptions {
	/** URL lifetime in seconds. Default: 300 (5 minutes). Bounds: 1–604800. */
	expiresIn?: number;
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
	/** Content type. Driver-inferred for Local (extension-based), server-
	 *  reported for S3. Falls back to `application/octet-stream`. */
	mimeType: string;
	/** Last-modified timestamp as a `Date` — not a string, not epoch ms. */
	lastModified: Date;
	/** Strong or weak ETag with surrounding quotes stripped. `W/` prefix
	 *  is preserved when the origin reports a weak tag. */
	etag: string;
	/** Public/private visibility. Missing-sidecar on Local = `'public'`. */
	visibility: Visibility;
}

/**
 * StorageDriver contract — frozen at v1.0 (Epic 43, 2026-05-05).
 *
 * Driver authors implement this interface verbatim. The interface is treated
 * as a stable contract: new methods are NOT added without a version-bump + a
 * 2-epic deprecation window. Optional fields are added in minor versions.
 * Method signatures never change in-place — a renamed method ships as a new
 * method + the old one delegating, deprecated for ≥1 epic.
 */
export interface StorageDriver {
	put(filePath: string, content: Buffer | string): Promise<void>;
	/**
	 * Upload from a readable stream. Local pipes to disk; S3 uses
	 * single-PUT if `contentLength ≤ 5 MiB`, otherwise multipart.
	 */
	putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		options?: PutStreamOptions,
	): Promise<void>;
	get(filePath: string): Promise<Buffer | null>;
	/**
	 * Download as a readable stream. Throws `ARCHIVE_NOT_FOUND` when
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
	 * `ARCHIVE_INVALID_EXPIRY`.
	 */
	getSignedUrl(
		filePath: string,
		options?: SignedUrlOptions,
	): string | Promise<string>;
	/**
	 * Resolve object metadata. Throws `ArchiveError('ARCHIVE_NOT_FOUND', ...)`
	 * when the object does not exist.
	 */
	getMetadata(filePath: string): Promise<Metadata>;
	/**
	 * Set `public` / `private` visibility. Idempotent — re-applying the
	 * same visibility succeeds silently.
	 */
	setVisibility(filePath: string, visibility: Visibility): Promise<void>;
	/**
	 * Duplicate an object. Throws `ARCHIVE_NOT_FOUND` if `from` is
	 * missing. Target is overwritten if it exists. Visibility is NOT
	 * carried over — the new object takes default visibility.
	 */
	copy(from: string, to: string): Promise<void>;
	/**
	 * Relocate an object. Equivalent to `copy` + `delete` on cloud
	 * drivers (non-atomic between the two steps); atomic `rename` on
	 * Local. Visibility IS preserved because identity is preserved.
	 */
	move(from: string, to: string): Promise<void>;
	/**
	 * Yield one {@link StorageEntry} per object whose path starts with
	 * `prefix`. Pagination (S3/GCS) and filesystem walk (Local) happen
	 * lazily — callers can `break` early and no further requests are
	 * issued.
	 */
	list(prefix: string): AsyncIterable<StorageEntry>;
}

export interface LocalDriverOptions {
	/**
	 * HMAC-SHA256 secret used by {@link LocalDriver.getSignedUrl}.
	 * When omitted, signing is disabled and `getSignedUrl` throws
	 * `ARCHIVE_SIGNING_DISABLED`. The non-signing methods
	 * (`put`/`get`/`delete`/`exists`/`url`) work either way.
	 */
	signingSecret?: string;
}

export class LocalDriver implements StorageDriver {
	#root: string;
	#signingSecret: string | null;

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
					"ARCHIVE_WEAK_SIGNING_SECRET",
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
	 * Resolve and validate a file path — prevents traversal outside
	 * the root, INCLUDING via symlinks planted inside the root.
	 *
	 * For existing files the check walks `fs.realpathSync(full)` to
	 * defeat symlink redirection. For new writes (target doesn't exist
	 * yet) we walk the nearest existing ancestor via `realpathSync` so
	 * an attacker who planted a symlink at `<root>/evil -> /etc`
	 * cannot redirect a put through it.
	 */
	#safePath(filePath: string): string {
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
		// Lexical guard first — cheap and covers the `..` case.
		if (!full.startsWith(this.#root + path.sep) && full !== this.#root) {
			throw new Error(
				`Path traversal blocked: '${filePath}' resolves outside storage root`,
			);
		}
		// Realpath guard — walk up to the nearest existing ancestor and
		// confirm its canonical form is still under root.
		let probe = full;
		while (!fs.existsSync(probe)) {
			const parent = path.dirname(probe);
			if (parent === probe) break;
			probe = parent;
		}
		const realProbe = fs.realpathSync(probe);
		if (
			!realProbe.startsWith(this.#root + path.sep) &&
			realProbe !== this.#root
		) {
			throw new Error(
				`Path traversal blocked: '${filePath}' resolves outside storage root via symlink`,
			);
		}
		return full;
	}

	async put(filePath: string, content: Buffer | string): Promise<void> {
		const full = this.#safePath(filePath);
		const dir = path.dirname(full);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(full, content);
	}

	async putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		// LocalDriver ignores contentType (inferred from extension via
		// getMetadata) and contentLength (FS knows its own size).
		_options?: PutStreamOptions,
	): Promise<void> {
		const full = this.#safePath(filePath);
		const dir = path.dirname(full);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// `pipeline` propagates errors and destroys the write target on
		// failure — no manual cleanup needed.
		await pipeline(readable, fs.createWriteStream(full));
	}

	async get(filePath: string): Promise<Buffer | null> {
		const full = this.#safePath(filePath);
		if (!fs.existsSync(full)) return null;
		return fs.readFileSync(full);
	}

	async getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		const full = this.#safePath(filePath);
		if (!fs.existsSync(full)) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`File does not exist at path '${filePath}'`,
				{ hint: "Confirm the path and that the file was put() first." },
			);
		}
		return fs.createReadStream(full);
	}

	async delete(filePath: string): Promise<boolean> {
		const full = this.#safePath(filePath);
		if (!fs.existsSync(full)) return false;
		fs.unlinkSync(full);
		// Sidecar cleanup is best-effort. The main file is already gone
		// — any sidecar failure (ENOENT, EACCES, EPERM) would corrupt
		// the `delete` contract if we threw here (caller would see a
		// rejected Promise AFTER the file was already deleted).
		const sidecar = full + VISIBILITY_SIDECAR_SUFFIX;
		try {
			fs.unlinkSync(sidecar);
		} catch {
			// swallow: cleanup is best-effort.
		}
		return true;
	}

	async exists(filePath: string): Promise<boolean> {
		// Sidecars are an implementation detail — pretend they don't
		// exist from the public API's point of view.
		if (filePath.endsWith(VISIBILITY_SIDECAR_SUFFIX)) return false;
		return fs.existsSync(this.#safePath(filePath));
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
		const visibility = this.#readVisibility(filePath);
		if (visibility === "public") return this.publicUrl(filePath);
		return this.getSignedUrl(filePath);
	}

	async getMetadata(filePath: string): Promise<Metadata> {
		const full = this.#safePath(filePath);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(full);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ArchiveError(
					"ARCHIVE_NOT_FOUND",
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
		return {
			size: stat.size,
			mimeType: inferMimeType(path.extname(filePath).toLowerCase()),
			lastModified: stat.mtime,
			etag: `W/"${etagBody}"`,
			visibility: this.#readVisibility(filePath),
		};
	}

	async setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		const full = this.#safePath(filePath);
		if (!fs.existsSync(full)) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`Cannot set visibility — file does not exist at path '${filePath}'`,
				{ hint: "put() the file before calling setVisibility()." },
			);
		}
		const sidecar = full + VISIBILITY_SIDECAR_SUFFIX;
		fs.writeFileSync(sidecar, JSON.stringify({ visibility }), { flag: "w" });
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
	#readVisibility(filePath: string): Visibility {
		const sidecar = this.#safePath(filePath) + VISIBILITY_SIDECAR_SUFFIX;
		if (!fs.existsSync(sidecar)) return "public";
		let raw: string;
		try {
			raw = fs.readFileSync(sidecar, "utf8");
		} catch (err) {
			throw new ArchiveError(
				"ARCHIVE_VISIBILITY_CORRUPT",
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
				"ARCHIVE_VISIBILITY_CORRUPT",
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
		this.#safePath(filePath);
		const expiresIn = options?.expiresIn ?? DEFAULT_EXPIRES_IN;
		assertValidExpiry(expiresIn);
		const secret = this.#signingSecret;
		if (secret === null) {
			throw new ArchiveError(
				"ARCHIVE_SIGNING_DISABLED",
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
	 * @internal Used by the signed-route middleware to re-compute the
	 * HMAC server-side. Not part of the public `StorageDriver` contract.
	 */
	getSigningSecret(): string | null {
		return this.#signingSecret;
	}

	async copy(from: string, to: string): Promise<void> {
		const fromFull = this.#safePath(from);
		const toFull = this.#safePath(to);
		if (!fs.existsSync(fromFull)) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`Cannot copy — source does not exist at path '${from}'`,
				{ hint: "Confirm the source path was put() first." },
			);
		}
		const dir = path.dirname(toFull);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.copyFileSync(fromFull, toFull);
		// Intentionally do NOT copy the visibility sidecar — new object
		// takes default visibility. Documented in the story spec.
	}

	async move(from: string, to: string): Promise<void> {
		const fromFull = this.#safePath(from);
		const toFull = this.#safePath(to);
		if (!fs.existsSync(fromFull)) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
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
		const capturedVisibility: Visibility | undefined = fs.existsSync(
			fromSidecar,
		)
			? this.#readVisibility(from)
			: undefined;
		const dir = path.dirname(toFull);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		try {
			fs.renameSync(fromFull, toFull);
		} catch (err) {
			// Cross-device rename — fall back to copy+unlink.
			if ((err as NodeJS.ErrnoException).code === "EXDEV") {
				fs.copyFileSync(fromFull, toFull);
				fs.unlinkSync(fromFull);
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
				fs.writeFileSync(
					toSidecar,
					JSON.stringify({ visibility: capturedVisibility }),
					{ flag: "w" },
				);
			} catch (err) {
				throw new ArchiveError(
					"ARCHIVE_VISIBILITY_MOVE_FAILED",
					`move('${from}' -> '${to}'): main file moved but visibility sidecar write failed (${(err as NodeJS.ErrnoException).code ?? "unknown"}). Target visibility is undefined.`,
					{
						hint: "Re-apply visibility via setVisibility() on the target path.",
					},
				);
			}
			// Best-effort cleanup of the source sidecar — visibility is already
			// preserved on the target side. A failure here leaves a stale
			// sidecar pointing at the now-missing source file; benign.
			if (fs.existsSync(fromSidecar)) {
				try {
					fs.unlinkSync(fromSidecar);
				} catch {
					// benign — source dir may be cleaned up by later operations.
				}
			}
		}
	}

	async *list(prefix: string): AsyncIterable<StorageEntry> {
		if (!fs.existsSync(this.#root)) return;
		// `recursive: true` on readdirSync gives us every descendant in
		// one call; `withFileTypes: true` lets us skip directories and
		// inspect each entry without a follow-up stat for type.
		const entries = fs.readdirSync(this.#root, {
			recursive: true,
			withFileTypes: true,
		});
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			// Node's readdirSync returns `parentPath` on the Dirent (Node
			// 20.12+); fall back to `path` for older shapes.
			const parent =
				(entry as unknown as { parentPath?: string; path?: string })
					.parentPath ??
				(entry as unknown as { path?: string }).path ??
				this.#root;
			const full = path.join(parent, entry.name);
			const rel = path.relative(this.#root, full).split(path.sep).join("/");
			// Exclude sidecars — implementation detail.
			if (rel.endsWith(VISIBILITY_SIDECAR_SUFFIX)) continue;
			if (!rel.startsWith(prefix)) continue;
			const stat = fs.statSync(full);
			yield { path: rel, size: stat.size, lastModified: stat.mtime };
		}
	}
}

export class StorageManager {
	#driver: StorageDriver;

	constructor(driver: StorageDriver) {
		this.#driver = driver;
	}

	put(filePath: string, content: Buffer | string): Promise<void> {
		return this.#driver.put(filePath, content);
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

	publicUrl(filePath: string): string {
		return this.#driver.publicUrl(filePath);
	}

	getSignedUrl(
		filePath: string,
		options?: SignedUrlOptions,
	): string | Promise<string> {
		return this.#driver.getSignedUrl(filePath, options);
	}

	getMetadata(filePath: string): Promise<Metadata> {
		return this.#driver.getMetadata(filePath);
	}

	setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		return this.#driver.setVisibility(filePath, visibility);
	}

	copy(from: string, to: string): Promise<void> {
		return this.#driver.copy(from, to);
	}

	move(from: string, to: string): Promise<void> {
		return this.#driver.move(from, to);
	}

	list(prefix: string): AsyncIterable<StorageEntry> {
		return this.#driver.list(prefix);
	}
}
