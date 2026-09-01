/**
 * Entity tags for static responses.
 *
 * Two rules from RFC 9110 that a hand-rolled digest tends to miss, and that
 * both cost a conditional request when missed:
 *
 *   - §8.8.3 — an entity-tag IS a quoted string. A bare hex digest is not one,
 *     and a strict cache is entitled to ignore it, which turns every
 *     revalidation back into a full transfer.
 *   - §13.1.2 — `If-None-Match` is a LIST, compared with the WEAK comparison
 *     function, so `W/"x"` and `"x"` match. Raw equality against the whole
 *     header value fails a client that sends two tags, and fails every client
 *     that sends back the weak form of a strong tag.
 *
 * Archive is agnostic, so this lives here rather than being imported from the
 * framework; `@c9up/ream` carries the same two rules in its own `http/etag`.
 */

/**
 * The tag for a file, from its metadata rather than its bytes.
 *
 * `W/"<size hex>-<mtime hex>"`, which is what the `etag` package produces for
 * a `Stats` and therefore what every static file server people have cached
 * against emits. Weak because it is derived from metadata: two files with the
 * same size and mtime are equivalent for caching, not provably identical.
 */
export function statTag(stat: { size: number; mtimeMs: number }): string {
	return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** Whether `If-None-Match` covers `tag` (RFC 9110 §13.1.2). */
export function matchesIfNoneMatch(
	header: string | undefined,
	tag: string,
): boolean {
	if (!header || tag === "") return false;
	if (header.trim() === "*") return true;
	const bare = (value: string): string =>
		value.startsWith("W/") ? value.slice(2) : value;
	const current = bare(tag);
	return header
		.split(",")
		.some((candidate) => bare(candidate.trim()) === current);
}
