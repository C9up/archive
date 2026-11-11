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

import { ArchiveError } from "./errors.js";

/** `%2e` (`.`), `%2f` (`/`), `%5c` (`\`), `%00` (NUL), any case. */
const ENCODED_SEPARATOR = /%(2f|5c|00)/i;
const ENCODED_DOT = /%2e/gi;

function unallowed(key: string, what: string): ArchiveError {
	return new ArchiveError(
		"E_ARCHIVE_UNALLOWED_CHARACTERS",
		`The key ${JSON.stringify(key)} has unallowed characters: ${what}`,
		{
			hint: "Use '/' as the only separator, and no control characters.",
		},
	);
}

function traversal(key: string): ArchiveError {
	return new ArchiveError(
		"E_ARCHIVE_PATH_TRAVERSAL_DETECTED",
		`Path traversal segment detected in key ${JSON.stringify(key)}`,
		{
			hint: "Keys are relative to the disk: build them without '..' segments.",
		},
	);
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

/**
 * Normalise an object key: collapse repeated `/`, drop `.` segments and the
 * leading/trailing `/`. Throws `E_ARCHIVE_PATH_TRAVERSAL_DETECTED` on a
 * dot-only segment, `E_ARCHIVE_UNALLOWED_CHARACTERS` on a control character,
 * a backslash or an encoded separator, and `E_ARCHIVE_INVALID_KEY` when
 * nothing is left.
 */
export function normalizeKey(key: string): string {
	const normalized = segments(key).join("/");
	if (normalized === "") {
		throw new ArchiveError(
			"E_ARCHIVE_INVALID_KEY",
			`Invalid key ${JSON.stringify(key)}. After normalization results in an empty string`,
			{ hint: "Name the object: a key cannot be empty or only separators." },
		);
	}
	return normalized;
}

/**
 * Normalise a listing prefix. Same rules as {@link normalizeKey}, except that
 * the root (`""` or `/`) is a valid prefix and a trailing `/` is kept: it is
 * what tells `avatars/` (that directory) from `avatars` (anything starting
 * with those letters).
 */
export function normalizePrefix(prefix: string): string {
	const normalized = segments(prefix).join("/");
	if (normalized === "") return "";
	return prefix.endsWith("/") ? `${normalized}/` : normalized;
}
