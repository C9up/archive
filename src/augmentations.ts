/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens archive binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Nothing filled
 * these in, so resolving by the string token answered `unknown` and every call
 * site had to assert a type it could not prove.
 *
 * Loaded from the package barrel, so importing Archive anywhere in the
 * application is enough — nobody writes a `declare module` of their own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentations below resolve the modules they augment.
import type {} from "@c9up/ream";
import type {} from "@c9up/ream/types";

import type { DriveManager } from "./DriveManager.js";
import type { MoveToDiskOptions } from "./move-to-disk.js";
import type { StorageManager } from "./StorageManager.js";

declare module "@c9up/ream" {
	interface MultipartFile {
		/**
		 * Write the upload into a disk (the default one when `disk` is
		 * omitted), set `meta.url` to its URL when the disk can name one, and
		 * mark the file as moved under its key.
		 *
		 * Attached by `ArchiveProvider` at boot. The key is normalised like any
		 * other: a `..` segment or a backslash is refused before anything is
		 * written.
		 */
		moveToDisk(
			key: string,
			disk?: string,
			options?: MoveToDiskOptions,
		): Promise<void>;
		/** Same, on the default disk. */
		moveToDisk(key: string, options?: MoveToDiskOptions): Promise<void>;
	}
}

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The drive manager, bound by `ArchiveProvider`. */
		"archive.drive": DriveManager;
		/**
		 * The same binding under the name it had before the token carried its
		 * package. Kept bound so an existing `container.make(...)` resolves.
		 */
		drive: DriveManager;
		/** The default disk, bound by `ArchiveProvider`. */
		"archive.storage": StorageManager;
		/**
		 * The same binding under the name it had before the token carried its
		 * package. Kept bound so an existing `container.make(...)` resolves.
		 */
		storage: StorageManager;
	}
}
