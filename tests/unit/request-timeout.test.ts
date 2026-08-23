/**
 * The cloud drivers made 37 `fetch` calls with no timeout. A hung connection
 * therefore never settled: the request handler awaiting it waited forever, and
 * enough of them stop the server from serving at all.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GcsDriver } from "../../src/GcsDriver.js";
import { S3Driver } from "../../src/S3Driver.js";

const s3 = (requestTimeoutMs?: number) =>
	new S3Driver({
		bucket: "b",
		region: "us-east-1",
		accessKeyId: "k",
		secretAccessKey: "s",
		...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
	});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("archive > request timeout", () => {
	it("passes an abort signal to the provider", async () => {
		const seen: RequestInit[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			seen.push(init);
			return new Response("", { status: 200 });
		});
		await s3().exists("a.txt");
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("reports a hung provider instead of waiting forever", async () => {
		vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
			// Never resolves on its own — only the signal can end this.
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					const err = new Error("timed out");
					err.name = "TimeoutError";
					reject(err);
				});
			});
		});
		await expect(s3(20).exists("a.txt")).rejects.toThrow(
			/did not answer within 20ms/,
		);
	});

	it("can be turned off deliberately", async () => {
		const seen: RequestInit[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			seen.push(init);
			return new Response("", { status: 200 });
		});
		await s3(0).exists("a.txt");
		expect(seen[0]?.signal).toBeUndefined();
	});

	it("bounds the GCS driver too", async () => {
		const seen: RequestInit[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			seen.push(init);
			// The first call is the token exchange; answer it so the second one
			// (the object request) is reached.
			return new Response(
				JSON.stringify({ access_token: "t", expires_in: 3600 }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});
		// A real key pair: the driver signs its token request, so a placeholder
		// would fail before any request went out.
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		const gcs = new GcsDriver({
			bucket: "b",
			serviceAccount: { client_email: "a@b.test", private_key: privateKey },
		});
		await gcs.exists("a.txt");
		expect(seen).not.toHaveLength(0);
		for (const init of seen) expect(init.signal).toBeInstanceOf(AbortSignal);
	});
});
