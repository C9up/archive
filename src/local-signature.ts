/**
 * What a local signed URL signs, shared by the driver that builds the URL and
 * the route that verifies it, so the two cannot drift apart.
 *
 * The payload is `<path>\n<exp>`, where `<path>` is the path the file is
 * served under — the disk's route base path, then the key — followed, only
 * when the URL carries response-header overrides, by `\n` and those overrides
 * as an encoded query string in a fixed order. Neither the base path nor the
 * key can contain `\n` (both refuse control characters and whitespace in the
 * base path), `exp` is digits and the overrides line is percent-encoded, so no
 * part can pose as another.
 *
 * The base path is signed so that a URL signed by one disk is refused by
 * another one sharing its secret (the documented `APP_KEY`), as upstream
 * signs the whole route URL.
 */

import { E_ARCHIVE_INVALID_HEADER_VALUE } from "./errors.js";

/** Override query parameters, in signing order, and the header each sets. */
export const HEADER_OVERRIDES = [
	["contentType", "Content-Type"],
	["contentDisposition", "Content-Disposition"],
] as const;

export type HeaderOverrideParam = (typeof HEADER_OVERRIDES)[number][0];

/** One override as it travels: query parameter name, header value. */
export type HeaderOverride = readonly [HeaderOverrideParam, string];

/**
 * Whether `value` can be sent as a header value: no control character
 * (horizontal tab aside), so it can neither end the header line nor split
 * the response.
 */
export function isHeaderValue(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
	}
	return true;
}

/** The overrides requested by signing options, validated, in signing order. */
export function requestedOverrides(options: {
	contentType?: string;
	contentDisposition?: string;
}): HeaderOverride[] {
	const overrides: HeaderOverride[] = [];
	for (const [param, header] of HEADER_OVERRIDES) {
		const value = options[param];
		if (value === undefined || value === "") continue;
		if (!isHeaderValue(value)) {
			throw new E_ARCHIVE_INVALID_HEADER_VALUE([param, header]);
		}
		overrides.push([param, value]);
	}
	return overrides;
}

/** The path a key is served under: the route base path, then the key. */
export function servedPath(routeBasePath: string, key: string): string {
	return `${routeBasePath}/${key}`;
}

/** The HMAC input for a served path, an expiry and its overrides. */
export function signedPayload(
	path: string,
	exp: number,
	overrides: readonly HeaderOverride[],
): string {
	const base = `${path}\n${exp}`;
	if (overrides.length === 0) return base;
	return `${base}\n${overrideQuery(overrides)}`;
}

/** The overrides as `name=value&…`, values percent-encoded. */
export function overrideQuery(overrides: readonly HeaderOverride[]): string {
	return overrides
		.map(([param, value]) => `${param}=${encodeURIComponent(value)}`)
		.join("&");
}
