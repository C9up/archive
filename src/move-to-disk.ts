/**
 * `MultipartFile.moveToDisk(key, disk?, options?)` — the storage half of an
 * upload, attached to ream's `MultipartFile` as a macro by `ArchiveProvider`.
 *
 *   await request.file('avatar')?.moveToDisk(`avatars/${user.id}.png`)
 *   await request.file('invoice')?.moveToDisk('invoices/a.pdf', 's3', {
 *     visibility: 'private',
 *   })
 *
 * The upload is written to the disk, `file.meta.url` is set to its URL when
 * the disk can name one, and the file is marked as moved under its key.
 */

import type { Exception } from "@c9up/flare";
import type { MultipartFile } from "@c9up/ream";
import type { DriveManager } from "./DriveManager.js";
import {
	E_ARCHIVE_INVALID_KEY,
	E_ARCHIVE_INVALID_MOVE_OPTIONS,
	E_ARCHIVE_MULTIPART_NOT_MACROABLE,
} from "./errors.js";
import { normalizeKey } from "./keys.js";
import type { Visibility, WriteOptions } from "./StorageManager.js";

/** What `moveToDisk` accepts on top of the disk's write options. */
export interface MoveToDiskOptions extends WriteOptions {
	/**
	 * `'stream'` (the default) pipes the upload into the disk, which lets a
	 * cloud disk send a large file in bounded parts. `'buffer'` hands the
	 * disk the whole file in one write.
	 */
	moveAs?: "stream" | "buffer";
}

/** The class side of ream's `MultipartFile`: what attaching a macro needs. */
interface MacroableClass {
	macro(name: string, fn: (...args: unknown[]) => unknown): void;
}

function isMacroableClass(value: unknown): value is MacroableClass {
	return (
		typeof value === "function" &&
		"macro" in value &&
		typeof value.macro === "function"
	);
}

/** Node's refusal when `@c9up/ream` itself is not installed. */
function isReamMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "ERR_MODULE_NOT_FOUND" &&
		error.message.includes("'@c9up/ream'")
	);
}

/**
 * Attach `moveToDisk` to ream's `MultipartFile`, writing into the disks
 * `drive` resolves.
 *
 * ream is an optional peer: in a host without it there are no uploads to
 * extend, and nothing is done. A ream whose `MultipartFile` cannot take a
 * macro is refused at boot rather than left alone — its own
 * `moveToDisk(directory, name)` would take `file.moveToDisk('a.png', 's3')`
 * as a local directory and a file name, and write the upload to the local
 * filesystem instead of the disk the application named.
 */
export async function extendMultipartFile(
	drive: () => DriveManager,
): Promise<void> {
	// Computed: ream is an optional peer, so a bundler must not try to
	// resolve it for a host that does not install it.
	const specifier = "@c9up/ream";
	let loaded: unknown;
	try {
		loaded = await import(/* @vite-ignore */ specifier);
	} catch (error) {
		if (isReamMissing(error)) return;
		throw error;
	}
	const multipartFile =
		typeof loaded === "object" && loaded !== null
			? Reflect.get(loaded, "MultipartFile")
			: undefined;
	if (!isMacroableClass(multipartFile)) {
		throw new E_ARCHIVE_MULTIPART_NOT_MACROABLE();
	}
	multipartFile.macro(
		"moveToDisk",
		async function (this: MultipartFile, ...args: unknown[]): Promise<void> {
			await moveToDisk(drive, this, args);
		},
	);
}

/**
 * Write `file` into a disk. `args` is what the application passed:
 * `(key, disk?, options?)` or `(key, options?)`.
 */
async function moveToDisk(
	drive: () => DriveManager,
	file: MultipartFile,
	args: unknown[],
): Promise<void> {
	const [key, diskOrOptions, writeOptions] = args;
	if (typeof key !== "string") {
		throw Object.assign(
			new E_ARCHIVE_INVALID_KEY([
				`moveToDisk() takes the object key as a string, got ${typeof key}`,
			]),
			{ help: "Pass the key first: file.moveToDisk('avatars/1.png')." },
		);
	}
	let diskName: string | undefined;
	let options: MoveToDiskOptions;
	if (typeof diskOrOptions === "string") {
		diskName = diskOrOptions;
		options = parseOptions(writeOptions);
	} else if (writeOptions === undefined) {
		options = parseOptions(diskOrOptions);
	} else if (diskOrOptions === undefined) {
		options = parseOptions(writeOptions);
	} else {
		// NAMED DEVIATION: two option objects are refused. Upstream keeps the
		// second and drops the first, which silently discards a
		// `visibility: 'private'` written there.
		throw invalidOptions(
			"two option objects were passed; give the disk name as a string, or one options object",
		);
	}

	// Before the disk is touched: a key that names no object, or one that
	// climbs out of the disk, is refused with nothing written.
	const normalized = normalizeKey(key);
	const disk = drive().use(diskName);
	const { moveAs = "stream", ...write } = options;

	// NAMED DEVIATION: upstream streams from the temporary file the body
	// parser left on disk; ream holds the upload in memory, so 'stream'
	// pipes that buffer into the disk (a cloud disk still sends a large file
	// in bounded parts).
	//
	// The stream path carries what a streamed write carries: the visibility
	// (applied WITH the write, as put() applies it), the content type and
	// the length. Cache and disposition metadata go through put().
	const streamable =
		write.cacheControl === undefined && write.contentDisposition === undefined;
	if (moveAs === "stream" && streamable) {
		await disk.putStream(normalized, file.stream(), {
			visibility: write.visibility,
			contentType: write.contentType,
			contentLength: file.size,
		});
	} else {
		await disk.put(normalized, file.content, write);
	}

	try {
		file.meta.url = await disk.getUrl(normalized);
	} catch {
		// The object is stored: a disk that cannot name a URL for it (a
		// private local file without a signing secret) leaves `meta.url`
		// unset rather than failing a move that succeeded.
	}
	// NAMED DEVIATION: recorded under the key the object is actually stored
	// at, not the one passed in (upstream records the raw key):
	// `/avatars//1.png` is recorded as `avatars/1.png`.
	file.markAsMoved(normalized, normalized);
}

function invalidOptions(what: string): Exception {
	return new E_ARCHIVE_INVALID_MOVE_OPTIONS([what]);
}

function optionalString(
	value: object,
	name: "contentType" | "cacheControl" | "contentDisposition",
): string | undefined {
	const field: unknown = Reflect.get(value, name);
	if (field === undefined || typeof field === "string") return field;
	throw invalidOptions(`${name} must be a string`);
}

/**
 * Read the options the application passed. A value outside what a field
 * accepts is refused, not ignored: `visibility: 'privat'` must not store a
 * public object.
 */
function parseOptions(value: unknown): MoveToDiskOptions {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidOptions("expected an object");
	}
	const visibility: unknown = Reflect.get(value, "visibility");
	if (!(visibility === undefined || isVisibility(visibility))) {
		throw invalidOptions("visibility must be 'public' or 'private'");
	}
	const moveAs: unknown = Reflect.get(value, "moveAs");
	if (!(moveAs === undefined || moveAs === "stream" || moveAs === "buffer")) {
		throw invalidOptions("moveAs must be 'stream' or 'buffer'");
	}
	const contentLength: unknown = Reflect.get(value, "contentLength");
	if (
		!(
			contentLength === undefined ||
			(typeof contentLength === "number" &&
				Number.isSafeInteger(contentLength) &&
				contentLength >= 0)
		)
	) {
		throw invalidOptions("contentLength must be a non-negative integer");
	}
	return {
		visibility,
		moveAs,
		contentLength,
		contentType: optionalString(value, "contentType"),
		cacheControl: optionalString(value, "cacheControl"),
		contentDisposition: optionalString(value, "contentDisposition"),
	};
}

function isVisibility(value: unknown): value is Visibility {
	return value === "public" || value === "private";
}
