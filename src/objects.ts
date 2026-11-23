/**
 * DriveFile / DriveDirectory — the object types yielded by
 * {@link StorageDriver.listAll} (AdonisJS Drive / flydrive parity).
 *
 * `listAll` returns a mix of these: files carry a lazy pointer to the
 * driver (so `getBytes()`/`getMetaData()` can be resolved on demand)
 * plus an optional metadata snapshot captured during the listing;
 * directories are prefix markers surfaced only for non-recursive
 * listings.
 */

import { basename } from "node:path";
import {
	E_CANNOT_CHECK_FILE_EXISTENCE,
	E_CANNOT_GENERATE_URL,
	E_CANNOT_GET_METADATA,
	E_CANNOT_READ_FILE,
} from "./errors.js";
import { isKeyRefusal, normalizeKey } from "./keys.js";
import type {
	Metadata,
	SignedUrlOptions,
	StorageDriver,
	Visibility,
} from "./StorageManager.js";

/**
 * Run a driver operation, wrapping whatever it throws in the disk's error for
 * that operation, the driver's error as `cause` — what the storage library
 * does on every disk operation.
 *
 * A refused key is not wrapped. The library normalises a key before the
 * operation it wraps, so its key refusals keep their code; archive's local
 * disk enforces two more key rules of its own (a reserved marker name, a path
 * that escapes the root through a link), and they keep theirs the same way.
 */
export async function wrapFailure<T>(
	work: () => Promise<T>,
	wrap: (cause: unknown) => Error,
): Promise<T> {
	try {
		return await work();
	} catch (error) {
		throw isKeyRefusal(error) ? error : wrap(error);
	}
}

/**
 * {@link wrapFailure} for a URL, which a driver may build synchronously (a
 * local signature) or asynchronously (a cloud presign): the result keeps the
 * shape the driver gave it.
 */
export function wrapUrlFailure(
	key: string,
	work: () => string | Promise<string>,
): string | Promise<string> {
	const wrap = (error: unknown): unknown =>
		isKeyRefusal(error)
			? error
			: new E_CANNOT_GENERATE_URL([key], { cause: error });
	let url: string | Promise<string>;
	try {
		url = work();
	} catch (error) {
		throw wrap(error);
	}
	if (typeof url === "string") return url;
	return url.catch((error: unknown) => {
		throw wrap(error);
	});
}

/**
 * Representation of a directory in a non-recursive listing. Mirrors
 * flydrive's `DriveDirectory`.
 */
export class DriveDirectory {
	isFile: false = false;
	isDirectory: true = true;
	name: string;

	constructor(public prefix: string) {
		this.name = basename(prefix);
	}
}

/**
 * Pointer to a stored object. Returned by `listAll`; also usable as a
 * lazy handle for reading contents / metadata. Mirrors flydrive's
 * `DriveFile` but built on the in-package {@link StorageDriver} contract
 * (no router coupling — the legitimate ream divergence).
 */
/** A file described without its provider (flydrive `FileSnapshot`). */
export interface FileSnapshot {
	key: string;
	name: string;
	contentLength: number;
	/** ISO-8601 — a snapshot is meant to survive JSON. */
	lastModified: string;
	etag: string;
	contentType?: string;
}

export class DriveFile {
	isFile: true = true;
	isDirectory: false = false;
	key: string;
	name: string;
	#driver: StorageDriver;
	#metadata?: Metadata;

	constructor(key: string, driver: StorageDriver, metadata?: Metadata) {
		// Normalised like every key a disk accepts, so a handle built from a
		// stored snapshot or an untrusted name cannot address outside the disk.
		this.key = normalizeKey(key);
		this.name = basename(this.key);
		this.#driver = driver;
		this.#metadata = metadata;
	}

	/** Whether the object exists; a failure to tell is `E_CANNOT_CHECK_FILE_EXISTENCE`. */
	exists(): Promise<boolean> {
		return wrapFailure(
			() => this.#driver.exists(this.key),
			(cause) => new E_CANNOT_CHECK_FILE_EXISTENCE([this.key], { cause }),
		);
	}

	/**
	 * Raw contents (`Buffer | null`). See {@link StorageDriver.get}: absence
	 * is `null`, any failure `E_CANNOT_READ_FILE`.
	 */
	get(): Promise<Buffer | null> {
		return this.#read(() => this.#driver.get(this.key));
	}

	/** Contents; an absent object is `E_CANNOT_READ_FILE`, `E_ARCHIVE_NOT_FOUND` its `cause`. */
	getBytes(): Promise<Uint8Array> {
		return this.#read(() => this.#driver.getBytes(this.key));
	}

	getStream(): Promise<NodeJS.ReadableStream> {
		return this.#read(() => this.#driver.getStream(this.key));
	}

	#read<T>(work: () => Promise<T>): Promise<T> {
		return wrapFailure(
			work,
			(cause) => new E_CANNOT_READ_FILE([this.key], { cause }),
		);
	}

	#metadataOf<T>(work: () => Promise<T>): Promise<T> {
		return wrapFailure(
			work,
			(cause) => new E_CANNOT_GET_METADATA([this.key], { cause }),
		);
	}

	/**
	 * Metadata for the object. Returns the snapshot captured during the
	 * listing when present; otherwise resolves it from the driver.
	 */
	getMetaData(): Promise<Metadata> {
		if (this.#metadata) return Promise.resolve(this.#metadata);
		return this.#metadataOf(() => this.#driver.getMetadata(this.key));
	}

	getVisibility(): Promise<Visibility> {
		return this.#metadataOf(() => this.#driver.getVisibility(this.key));
	}

	getUrl(): Promise<string> {
		return wrapFailure(
			() => this.#driver.url(this.key),
			(cause) => new E_CANNOT_GENERATE_URL([this.key], { cause }),
		);
	}

	/** Contents as bytes in an ArrayBuffer view — what a Blob or fetch body wants. */
	getArrayBuffer(): Promise<Uint8Array> {
		return this.getBytes();
	}

	/** A URL a client can upload TO, without going through the app. */
	getSignedUploadUrl(options?: SignedUrlOptions): string | Promise<string> {
		return wrapUrlFailure(this.key, () =>
			this.#driver.getSignedUploadUrl(this.key, options),
		);
	}

	/**
	 * A serializable description of this file (flydrive `toSnapshot`).
	 *
	 * Store it beside a record and rebuild the handle later with
	 * `disk.fromSnapshot(...)` — that avoids a round-trip to the provider just
	 * to render a name and a size.
	 */
	async toSnapshot(): Promise<FileSnapshot> {
		const metadata = await this.getMetaData();
		return {
			key: this.key,
			name: this.name,
			contentLength: metadata.contentLength,
			lastModified: metadata.lastModified.toISOString(),
			etag: metadata.etag,
			contentType: metadata.contentType,
		};
	}

	getSignedUrl(options?: SignedUrlOptions): string | Promise<string> {
		return wrapUrlFailure(this.key, () =>
			this.#driver.getSignedUrl(this.key, options),
		);
	}
}
