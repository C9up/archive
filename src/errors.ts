/**
 * ArchiveError — structured error (agnostic; no @c9up/ream dependency).
 */
export class ArchiveError extends Error {
	readonly code: string;
	readonly hint?: string;

	constructor(code: string, message: string, options?: { hint?: string }) {
		super(message);
		this.name = "ArchiveError";
		this.code = code;
		this.hint = options?.hint;
	}
}
