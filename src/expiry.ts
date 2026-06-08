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
