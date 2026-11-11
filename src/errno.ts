/**
 * The `code` a Node system error carries (`ENOENT`, `EXDEV`, …), or
 * `undefined` for anything else — read through a guard, not a cast.
 */
export function errnoCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("code" in err)) {
		return undefined;
	}
	return typeof err.code === "string" ? err.code : undefined;
}
