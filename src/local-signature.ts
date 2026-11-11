/**
 * What a local signed URL signs, shared by the driver that builds the URL and
 * the route that verifies it, so the two cannot drift apart.
 *
 * The payload is `<key>\n<exp>`, followed — only when the URL carries
 * response-header overrides — by `\n` and those overrides as an encoded query
 * string in a fixed order. A key cannot contain `\n` (the key normaliser
 * refuses control characters), `exp` is digits and the overrides line is
 * percent-encoded, so no part can pose as another. A URL signed without
 * overrides keeps the payload it always had.
 */

import { ArchiveError } from "./errors.js";

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
			throw new ArchiveError(
				"E_ARCHIVE_INVALID_HEADER_VALUE",
				`${param} cannot be signed as a ${header} value: it contains a control character`,
				{ hint: "Header values cannot carry CR, LF, NUL or other controls." },
			);
		}
		overrides.push([param, value]);
	}
	return overrides;
}

/** The HMAC input for a key, an expiry and its overrides. */
export function signedPayload(
	key: string,
	exp: number,
	overrides: readonly HeaderOverride[],
): string {
	const base = `${key}\n${exp}`;
	if (overrides.length === 0) return base;
	return `${base}\n${overrideQuery(overrides)}`;
}

/** The overrides as `name=value&…`, values percent-encoded. */
export function overrideQuery(overrides: readonly HeaderOverride[]): string {
	return overrides
		.map(([param, value]) => `${param}=${encodeURIComponent(value)}`)
		.join("&");
}
