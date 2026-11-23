import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";

describe("archive > errors", () => {
	it("are exported from the entry as flare exceptions, one class per code", () => {
		const error = new errors.E_ARCHIVE_NOT_FOUND([
			"File does not exist at path 'a.txt'",
		]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_ARCHIVE_NOT_FOUND",
			status: 404,
			message: "File does not exist at path 'a.txt'",
		});
		for (const [name, ErrorClass] of Object.entries(errors)) {
			expect(ErrorClass.code).toBe(name);
		}
	});

	it("keeps the storage library's codes for the key normaliser", () => {
		expect(new errors.E_INVALID_KEY(["//"])).toMatchObject({
			code: "E_INVALID_KEY",
			status: 500,
			message:
				'Invalid key "//". After normalization results in an empty string',
			help: "Name the object: a key cannot be empty or only separators.",
		});
	});

	it("keeps the provider's status apart from the HTTP status", () => {
		const error = new errors.E_ARCHIVE_REMOTE_FAILED(
			403,
			"S3 GET failed (403)",
		);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_ARCHIVE_REMOTE_FAILED",
			status: 500,
			providerStatus: 403,
		});
	});
});
