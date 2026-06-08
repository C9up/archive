/**
 * FakeStorage — in-memory StorageDriver for tests.
 *
 * Every StorageDriver method is implemented against a local `Map` —
 * no filesystem, no network. Use in tests that need to assert on
 * put/get/list/... behaviour without touching real storage.
 *
 *     const storage = new FakeStorage();
 *     await storage.put('cat.txt', 'meow');
 *     expect(await storage.get('cat.txt')).toEqual(Buffer.from('meow'));
 *     storage.clear();
 *
 * Kept behind the `./testing` subpath so production imports stay clean.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ArchiveError } from "../errors.js";
import { assertValidExpiry, DEFAULT_EXPIRES_IN } from "../expiry.js";
import { inferMimeType } from "../mime-types.js";
import type {
	Metadata,
	PutStreamOptions,
	SignedUrlOptions,
	StorageDriver,
	StorageEntry,
	Visibility,
} from "../StorageManager.js";

interface StoredObject {
	content: Buffer;
	visibility: Visibility;
	lastModified: Date;
	mimeType: string;
}

/** Deterministic secret for FakeStorage signatures. Not a real HMAC
 *  key — signatures are opaque, for shape-matching in test assertions. */
const FAKE_SECRET = "archive-fake-signing-secret-do-not-use-in-prod";

export class FakeStorage implements StorageDriver {
	#store = new Map<string, StoredObject>();

	async put(filePath: string, content: Buffer | string): Promise<void> {
		const buf = typeof content === "string" ? Buffer.from(content) : content;
		this.#store.set(filePath, {
			content: Buffer.from(buf),
			visibility: this.#store.get(filePath)?.visibility ?? "public",
			lastModified: new Date(),
			mimeType:
				inferMimeType(extFromPath(filePath)) || "application/octet-stream",
		});
	}

	async putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		options?: PutStreamOptions,
	): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of readable) {
			chunks.push(
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
			);
		}
		const buf = Buffer.concat(chunks);
		this.#store.set(filePath, {
			content: buf,
			visibility: this.#store.get(filePath)?.visibility ?? "public",
			lastModified: new Date(),
			mimeType:
				options?.contentType ??
				(inferMimeType(extFromPath(filePath)) || "application/octet-stream"),
		});
	}

	async get(filePath: string): Promise<Buffer | null> {
		const obj = this.#store.get(filePath);
		return obj ? Buffer.from(obj.content) : null;
	}

	async getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		const obj = this.#store.get(filePath);
		if (!obj) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`Fake object does not exist at path '${filePath}'`,
				{ hint: "put() it first, or verify the test setup." },
			);
		}
		return Readable.from(obj.content);
	}

	async delete(filePath: string): Promise<boolean> {
		return this.#store.delete(filePath);
	}

	async exists(filePath: string): Promise<boolean> {
		return this.#store.has(filePath);
	}

	publicUrl(filePath: string): string {
		return `fake://${filePath}`;
	}

	async url(filePath: string): Promise<string> {
		const obj = this.#store.get(filePath);
		if (obj?.visibility === "private") return this.getSignedUrl(filePath);
		return this.publicUrl(filePath);
	}

	getSignedUrl(filePath: string, options?: SignedUrlOptions): string {
		const expiresIn = options?.expiresIn ?? DEFAULT_EXPIRES_IN;
		assertValidExpiry(expiresIn);
		const exp = Math.floor(Date.now() / 1000) + expiresIn;
		const sig = createHash("sha256")
			.update(`${filePath}.${exp}.${FAKE_SECRET}`)
			.digest("hex");
		return `fake://${filePath}?exp=${exp}&sig=${sig}`;
	}

	async getMetadata(filePath: string): Promise<Metadata> {
		const obj = this.#store.get(filePath);
		if (!obj) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`Fake object does not exist at path '${filePath}'`,
				{ hint: "put() it first, or verify the test setup." },
			);
		}
		// Weak ETag deterministic on content hash — useful for
		// assertion stability in tests.
		const etagBody = createHash("sha1").update(obj.content).digest("hex");
		return {
			size: obj.content.length,
			mimeType: obj.mimeType,
			lastModified: obj.lastModified,
			etag: `W/"${etagBody}"`,
			visibility: obj.visibility,
		};
	}

	async setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		const obj = this.#store.get(filePath);
		if (!obj) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`Cannot set visibility — fake object does not exist at path '${filePath}'`,
				{ hint: "put() the file before calling setVisibility()." },
			);
		}
		obj.visibility = visibility;
	}

	async copy(from: string, to: string): Promise<void> {
		const src = this.#store.get(from);
		if (!src) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`Cannot copy — fake source does not exist at path '${from}'`,
				{ hint: "Confirm the source path was put() first." },
			);
		}
		// Default visibility on the new object — matches LocalDriver
		// semantics (AC 4 from Story 43.6).
		this.#store.set(to, {
			content: Buffer.from(src.content),
			visibility: "public",
			lastModified: new Date(),
			mimeType: src.mimeType,
		});
	}

	async move(from: string, to: string): Promise<void> {
		const src = this.#store.get(from);
		if (!src) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`Cannot move — fake source does not exist at path '${from}'`,
				{ hint: "Confirm the source path was put() first." },
			);
		}
		// Move preserves visibility — identity is preserved.
		this.#store.set(to, { ...src, content: Buffer.from(src.content) });
		this.#store.delete(from);
	}

	async *list(prefix: string): AsyncIterable<StorageEntry> {
		for (const [path, obj] of this.#store) {
			if (!path.startsWith(prefix)) continue;
			yield { path, size: obj.content.length, lastModified: obj.lastModified };
		}
	}

	/** Test helper — wipe all state. */
	clear(): void {
		this.#store.clear();
	}

	/** Alias for `clear()` — exists so the API matches helix's
	 *  `storage.reset()` forwarder convention (and matches the shape
	 *  of `FakeMail` / `FakeQueue` / `FakeLogger` / `FakeRelay`). */
	reset(): void {
		this.#store.clear();
	}

	/** Test helper — snapshot current state as `{ path: content }`.
	 *  Kept for backwards-compat; new tests should prefer
	 *  `getStored()` which returns richer entries. */
	dump(): Record<string, Buffer> {
		const out: Record<string, Buffer> = {};
		for (const [path, obj] of this.#store) {
			out[path] = Buffer.from(obj.content);
		}
		return out;
	}

	/**
	 * Defensive snapshot of stored objects, suitable for test
	 * assertions. Each entry is a fresh shallow clone so test-side
	 * mutation can't bleed back into the internal store.
	 */
	getStored(): Array<{
		path: string;
		content: Buffer;
		mimeType: string;
		visibility: Visibility;
	}> {
		const out: Array<{
			path: string;
			content: Buffer;
			mimeType: string;
			visibility: Visibility;
		}> = [];
		for (const [path, obj] of this.#store) {
			out.push({
				path,
				content: Buffer.from(obj.content),
				mimeType: obj.mimeType,
				visibility: obj.visibility,
			});
		}
		return out;
	}

	assertStored(path: string, predicate?: FakeStoragePredicateArg): void {
		const match = makeStorageMatcher(path, predicate);
		for (const [p, obj] of this.#store) {
			if (match(p, obj)) return;
		}
		throw new Error(
			`storage.assertStored('${path}'${describeStoragePredicate(predicate)}) failed — no captured object matches.\n${describeStorageCaptured(this.#store)}`,
		);
	}

	assertNotStored(path: string, predicate?: FakeStoragePredicateArg): void {
		const match = makeStorageMatcher(path, predicate);
		for (const [p, obj] of this.#store) {
			if (match(p, obj)) {
				throw new Error(
					`storage.assertNotStored('${path}'${describeStoragePredicate(predicate)}) failed — at least one captured object matches.\n${describeStorageCaptured(this.#store)}`,
				);
			}
		}
	}
}

export interface FakeStoragePredicate {
	/** Substring match against the stored content, viewed as UTF-8.
	 *  Non-UTF-8 binary payloads (PNG, PDF, ...) will be lossily
	 *  decoded — for binary content prefer the function-predicate
	 *  form which receives the raw `Buffer`. */
	contentContaining?: string;
	/** Mime-type match. Comparison is case-insensitive — RFC 2045 §5.1
	 *  treats media types as case-insensitive, and storage backends
	 *  often normalise inconsistently. */
	mimeType?: string;
}

export type FakeStoragePredicateArg =
	| FakeStoragePredicate
	| ((entry: { path: string; content: Buffer; mimeType: string }) => boolean);

function makeStorageMatcher(
	path: string,
	predicate: FakeStoragePredicateArg | undefined,
): (storedPath: string, obj: { content: Buffer; mimeType: string }) => boolean {
	if (typeof predicate === "function") {
		return (p, obj) =>
			p === path &&
			predicate({ path: p, content: obj.content, mimeType: obj.mimeType });
	}
	if (predicate === undefined) {
		return (p) => p === path;
	}
	// Validate the predicate AT CONSTRUCTION, not inside the closure —
	// `for (...) match(...)` would silently never see the throw if the
	// store happens to be empty, hiding the test-fixture mistake.
	if (predicate.contentContaining === "") {
		throw new Error(
			"FakeStorage: `contentContaining` predicate cannot be an empty string — it would match every captured object.",
		);
	}
	const expectedMime = predicate.mimeType?.toLowerCase();
	return (p, obj) => {
		if (p !== path) return false;
		if (
			predicate.contentContaining !== undefined &&
			!obj.content.toString("utf-8").includes(predicate.contentContaining)
		) {
			return false;
		}
		if (
			expectedMime !== undefined &&
			obj.mimeType.toLowerCase() !== expectedMime
		) {
			return false;
		}
		return true;
	};
}

function describeStoragePredicate(
	predicate: FakeStoragePredicateArg | undefined,
): string {
	if (predicate === undefined) return "";
	if (typeof predicate === "function") return ", <function predicate>";
	if (Object.keys(predicate).length === 0) {
		return ", <empty predicate (path-only)>";
	}
	return `, ${safeStringify(predicate)}`;
}

/** `JSON.stringify` with circular-ref + function-field handling.
 *  Functions render as `<function>`, circular refs as `<circular>`,
 *  unstringifiable values as `<unstringifiable>` — so an assertion
 *  failure message never gets eaten by a JSON throw. */
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(value, (_key, v: unknown) => {
			if (typeof v === "function") return "<function>";
			if (typeof v === "object" && v !== null) {
				if (seen.has(v)) return "<circular>";
				seen.add(v);
			}
			return v;
		});
	} catch {
		return "<unstringifiable>";
	}
}

function describeStorageCaptured(
	store: Map<string, { content: Buffer; mimeType: string }>,
): string {
	if (store.size === 0) return "Captured: (none)";
	const lines: string[] = [];
	let i = 0;
	for (const [p, obj] of store) {
		lines.push(
			`  [${i}] path="${p}" size=${obj.content.length} mime="${obj.mimeType}"`,
		);
		i++;
	}
	return `Captured (${store.size}):\n${lines.join("\n")}`;
}

function extFromPath(filePath: string): string {
	const idx = filePath.lastIndexOf(".");
	return idx < 0 ? "" : filePath.slice(idx).toLowerCase();
}
