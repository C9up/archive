/**
 * Shared expiry bounds for signed URLs. Both the S3 and Local drivers
 * enforce the same 1 s – 7 days envelope so surface behaviour stays
 * consistent across backends.
 */

import { ArchiveError } from "./errors.js";

/** Default expiry for signed URLs when the caller does not specify one. */
export const DEFAULT_EXPIRES_IN = 300; // 5 minutes

/** Maximum allowed expiry (AWS SigV4 cap). */
export const MAX_EXPIRES_IN = 604_800; // 7 days

/**
 * Multipliers (in seconds) for the human-friendly duration suffixes
 * accepted by {@link parseExpiry}. Mirrors the units understood by
 * AdonisJS Drive's `string.seconds.parse` helper.
 */
const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	sec: 1,
	secs: 1,
	second: 1,
	seconds: 1,
	m: 60,
	min: 60,
	mins: 60,
	minute: 60,
	minutes: 60,
	h: 3600,
	hr: 3600,
	hrs: 3600,
	hour: 3600,
	hours: 3600,
	d: 86_400,
	day: 86_400,
	days: 86_400,
	w: 604_800,
	week: 604_800,
	weeks: 604_800,
};

/**
 * Normalise a signed-URL `expiresIn` into a number of seconds. Accepts
 * either a raw number of seconds (returned as-is) or a human-friendly
 * duration string such as `'30mins'`, `'7 days'`, `'1h'` — AdonisJS
 * Drive parity. Unrecognised strings throw `ARCHIVE_INVALID_EXPIRY`.
 */
export function parseExpiry(expiresIn: number | string): number {
	if (typeof expiresIn === "number") return expiresIn;
	const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(expiresIn);
	const unitKey = match?.[2]?.toLowerCase() ?? "";
	const multiplier = unitKey === "" ? 1 : UNIT_SECONDS[unitKey];
	if (match === undefined || match === null || multiplier === undefined) {
		throw new ArchiveError(
			"ARCHIVE_INVALID_EXPIRY",
			`Signed-URL expiresIn string '${expiresIn}' could not be parsed`,
			{
				hint: "Use a number of seconds, or a duration like '30mins', '1h', '7 days'.",
			},
		);
	}
	return Math.round(Number.parseFloat(match[1]) * multiplier);
}

/**
 * Reject non-finite, zero, negative, or out-of-range expiries. Throws
 * `ARCHIVE_INVALID_EXPIRY` so callers get a typed error with a hint.
 */
export function assertValidExpiry(expiresIn: number): void {
	if (!Number.isFinite(expiresIn)) {
		throw new ArchiveError(
			"ARCHIVE_INVALID_EXPIRY",
			`Signed-URL expiresIn must be finite, got ${expiresIn}`,
			{ hint: "Pass a positive number of seconds between 1 and 604800." },
		);
	}
	if (expiresIn <= 0) {
		throw new ArchiveError(
			"ARCHIVE_INVALID_EXPIRY",
			`Signed-URL expiresIn must be > 0 seconds, got ${expiresIn}`,
			{ hint: "Pass a positive number of seconds between 1 and 604800." },
		);
	}
	if (expiresIn > MAX_EXPIRES_IN) {
		throw new ArchiveError(
			"ARCHIVE_INVALID_EXPIRY",
			`Signed-URL expiresIn must be <= ${MAX_EXPIRES_IN} seconds (7 days), got ${expiresIn}`,
			{ hint: "AWS SigV4 caps presigned URLs at 7 days." },
		);
	}
}
