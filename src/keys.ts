/**
 * Key normalisation, applied before any driver sees a key.
 *
 * Same rules as the upstream storage library's key normaliser, so `/a.txt`,
 * `a//b` and `./a` name the objects `a.txt`, `a/b` and `a` on every disk, and
 * a `..` segment is refused rather than resolved. Only the local disk used to
 * check containment, so on S3/GCS `publicUrl("../other-bucket/file.txt")`
 * built a link every URL parser resolves into another bucket on the same host.
 *
 * NAMED DEVIATION — the character set is wider and the refusals are stricter.
 * Upstream accepts only `[A-Za-z0-9-_!/. \s]`; here spaces, unicode and
 * dotfiles stay valid names (upstream also strips a leading `.`, turning
 * `.env` into `env`). In exchange, what upstream rewrites is refused: a
 * backslash (upstream turns it into `/`), control characters (upstream folds
 * them into a space), a dot-only segment of any length, and percent-encoded
 * dots, slashes, backslashes and NUL — a key that would turn into a traversal
 * or a separator once some layer decodes it.
 */

import type { Exception } from "@c9up/flare";
import {
	E_ARCHIVE_INVALID_KEY,
	E_ARCHIVE_PATH_TRAVERSAL_DETECTED,
	E_INVALID_KEY,
	E_PATH_TRAVERSAL_DETECTED,
	E_UNALLOWED_CHARACTERS,
} from "./errors.js";

/** `%2e` (`.`), `%2f` (`/`), `%5c` (`\`), `%00` (NUL), any case. */
const ENCODED_SEPARATOR = /%(2f|5c|00)/i;
const ENCODED_DOT = /%2e/gi;

/**
 * The key as the messages quote it: escaped the way JSON escapes a string, so
 * a CR, LF or other control character a refused key carries cannot forge a
 * log line, but without JSON's own quotes — the message supplies them.
 */
function quoted(key: string): string {
	return JSON.stringify(key).slice(1, -1);
}

function unallowed(key: string, what: string): Exception {
	const error = new E_UNALLOWED_CHARACTERS([quoted(key)]);
	// The library's message names the key only; which character is refused
	// goes in `help`.
	error.help = `Refused: ${what}. Use '/' as the only separator, and no control characters.`;
	return error;
}

function traversal(key: string): Exception {
	return new E_PATH_TRAVERSAL_DETECTED([quoted(key)]);
}

/**
 * The segments of `key`, validated, with empty and `.` segments dropped.
 * Throws on anything that is not a plain relative name.
 */
function segments(key: string): string[] {
	for (let i = 0; i < key.length; i++) {
		const code = key.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) {
			throw unallowed(key, "control characters are not allowed");
		}
	}
	if (key.includes("\\")) {
		throw unallowed(key, "a backslash is not a separator");
	}
	if (ENCODED_SEPARATOR.test(key)) {
		throw unallowed(key, "an encoded separator or NUL");
	}
	const kept: string[] = [];
	for (const segment of key.split("/")) {
		if (segment === "" || segment === ".") continue;
		// `..`, `...` and their encoded forms: never a name worth the risk.
		if (/^\.+$/.test(segment.replace(ENCODED_DOT, "."))) {
			throw traversal(key);
		}
		kept.push(segment);
	}
	return kept;
}

/** The refusals of a key a disk will not address. */
const KEY_REFUSALS = [
	E_INVALID_KEY,
	E_PATH_TRAVERSAL_DETECTED,
	E_UNALLOWED_CHARACTERS,
	E_ARCHIVE_INVALID_KEY,
	E_ARCHIVE_PATH_TRAVERSAL_DETECTED,
];

/**
 * Whether `error` refuses a key rather than reports a failed operation: the
 * normaliser's codes, and the two the local disk adds (a reserved marker name,
 * a path that escapes the root).
 */
export function isKeyRefusal(error: unknown): boolean {
	return KEY_REFUSALS.some((Refusal) => error instanceof Refusal);
}

/**
 * Normalise an object key: collapse repeated `/`, drop `.` segments and the
 * leading/trailing `/`. Throws `E_PATH_TRAVERSAL_DETECTED` on a dot-only
 * segment, `E_UNALLOWED_CHARACTERS` on a control character, a backslash or an
 * encoded separator, and `E_INVALID_KEY` when nothing is left.
 */
export function normalizeKey(key: string): string {
	const normalized = segments(key).join("/");
	if (normalized === "") {
		throw new E_INVALID_KEY([quoted(key)]);
	}
	return normalized;
}

/**
 * Normalise a listing or deletion prefix into the DIRECTORY it names. Same
 * rules as {@link normalizeKey}, except that the root (`""` or `/`) is a valid
 * prefix (and stays `""`, everything); any other prefix ends with `/`, so
 * `users/1` and `users/1/` both reach `users/1/**` and never `users/10/**`.
 *
 * Read as raw string prefixes, `deleteAll('users/1')` also deleted the files
 * of users 10 to 19, 100 to 199… with no error. This is the meaning
 * flydrive's FS driver (`rm -r` of that directory) and GCS driver (trailing
 * `/` forced) give a prefix.
 *
 * NAMED DEVIATION (stricter than flydrive's S3 driver, which hands the prefix
 * to S3 as is): the same directory meaning on every driver, S3 included.
 */
export function normalizePrefix(prefix: string): string {
	const normalized = segments(prefix).join("/");
	return normalized === "" ? "" : `${normalized}/`;
}
