/**
 * Shared MIME-type table used by `StaticMiddleware` and the signed-route
 * handler. Keeping a single table avoids drift between the two code
 * paths that serve files from disk.
 */

export const MIME_TYPES: Record<string, string> = {
	".avif": "image/avif",
	".css": "text/css",
	".eot": "application/vnd.ms-fontobject",
	".gif": "image/gif",
	".html": "text/html",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "application/javascript",
	".json": "application/json",
	".map": "application/json",
	".mjs": "application/javascript",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".ogg": "audio/ogg",
	".pdf": "application/pdf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ttf": "font/ttf",
	".txt": "text/plain",
	".wasm": "application/wasm",
	".webm": "video/webm",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".xml": "application/xml",
	".zip": "application/zip",
};

/**
 * Extensions served by the static middleware by default. Derived from
 * {@link MIME_TYPES} so new entries auto-apply — no drift possible.
 * Sorted deterministically via `localeCompare` for stable snapshots.
 */
export const DEFAULT_EXTENSIONS: readonly string[] = Object.keys(
	MIME_TYPES,
).sort((a, b) => a.localeCompare(b));

/** Resolve a file extension (including the dot, lowercase) to a MIME
 *  type. Falls back to `application/octet-stream` for unknown
 *  extensions — the caller decides whether that's acceptable. */
export function inferMimeType(ext: string): string {
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Types that are text without a `text/` prefix, so carry a charset. The rest
 * of `text/*` is covered by the prefix; everything else is binary.
 */
const UTF8_TYPES = new Set(["application/javascript", "application/json"]);

/**
 * A full `Content-Type` header value for a bare type: `; charset=utf-8`
 * appended to a text type, as upstream's `response.type()` does
 * (`mime-types.contentType`). A type that already names a charset, and a
 * binary one, are sent as is.
 */
export function contentTypeHeader(type: string): string {
	if (/;\s*charset=/i.test(type)) return type;
	const [head = ""] = type.split(";");
	const base = head.trim().toLowerCase();
	return base.startsWith("text/") || UTF8_TYPES.has(base)
		? `${type}; charset=utf-8`
		: type;
}
