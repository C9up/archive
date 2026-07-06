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
import type {
	Metadata,
	SignedUrlOptions,
	StorageDriver,
	Visibility,
} from "./StorageManager.js";

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
export class DriveFile {
	isFile: true = true;
	isDirectory: false = false;
	key: string;
	name: string;
	#driver: StorageDriver;
	#metadata?: Metadata;

	constructor(key: string, driver: StorageDriver, metadata?: Metadata) {
		this.key = key;
		this.name = basename(key);
		this.#driver = driver;
		this.#metadata = metadata;
	}

	exists(): Promise<boolean> {
		return this.#driver.exists(this.key);
	}

	/** Raw contents (`Buffer | null`). See {@link StorageDriver.get}. */
	get(): Promise<Buffer | null> {
		return this.#driver.get(this.key);
	}

	getBytes(): Promise<Uint8Array> {
		return this.#driver.getBytes(this.key);
	}

	getStream(): Promise<NodeJS.ReadableStream> {
		return this.#driver.getStream(this.key);
	}

	/**
	 * Metadata for the object. Returns the snapshot captured during the
	 * listing when present; otherwise resolves it from the driver.
	 */
	getMetaData(): Promise<Metadata> {
		if (this.#metadata) return Promise.resolve(this.#metadata);
		return this.#driver.getMetadata(this.key);
	}

	getVisibility(): Promise<Visibility> {
		return this.#driver.getVisibility(this.key);
	}

	getUrl(): Promise<string> {
		return this.#driver.url(this.key);
	}

	getSignedUrl(options?: SignedUrlOptions): string | Promise<string> {
		return this.#driver.getSignedUrl(this.key, options);
	}
}
