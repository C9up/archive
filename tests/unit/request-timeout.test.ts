/**
 * The cloud drivers made 37 `fetch` calls with no timeout. A hung connection
 * therefore never settled: the request handler awaiting it waited forever, and
 * enough of them stop the server from serving at all.
 */
import { generateKeyPairSync } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GcsDriver } from "../../src/GcsDriver.js";
import { S3Driver } from "../../src/S3Driver.js";

/** A local stand-in for the provider, answering with `handler`. */
async function fakeProvider(
	handler: http.RequestListener,
): Promise<{ endpoint: string; close(): Promise<void> }> {
	const server = http.createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("expected a TCP address");
	}
	const { port }: AddressInfo = address;
	return {
		endpoint: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function drain(readable: NodeJS.ReadableStream): Promise<number> {
	let total = 0;
	for await (const chunk of readable) {
		total += Buffer.isBuffer(chunk) ? chunk.length : String(chunk).length;
	}
	return total;
}

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

/**
 * The bound used to be a wall clock on the whole exchange, body included: a
 * download still being read, or an upload still being sent, was cut once it
 * had been running for `requestTimeoutMs`, however steadily it progressed.
 */
describe("archive > request timeout > an idle bound, not a deadline", () => {
	const s3At = (endpoint: string, requestTimeoutMs: number) =>
		new S3Driver({
			bucket: "b",
			endpoint,
			accessKeyId: "k",
			secretAccessKey: "s",
			requestTimeoutMs,
		});

	it("lets a download that keeps moving outlast the bound", async () => {
		const provider = await fakeProvider((_req, res) => {
			res.writeHead(200, { "content-type": "application/octet-stream" });
			let sent = 0;
			const tick = setInterval(() => {
				res.write("x".repeat(1024));
				if (++sent === 10) {
					clearInterval(tick);
					res.end();
				}
			}, 60);
		});
		try {
			// 10 chunks, 60 ms apart: ~600 ms in all, never 200 ms silent.
			const stream = await s3At(provider.endpoint, 200).getStream("big.bin");
			expect(await drain(stream)).toBe(10 * 1024);
		} finally {
			await provider.close();
		}
	});

	it("does not count the time a slow consumer holds a chunk", async () => {
		const provider = await fakeProvider((_req, res) => {
			res.writeHead(200);
			res.end("y".repeat(4096));
		});
		try {
			const res = await s3At(provider.endpoint, 100).getStream("a.bin");
			let total = 0;
			for await (const chunk of res) {
				total += Buffer.isBuffer(chunk) ? chunk.length : 0;
				await sleep(250);
			}
			expect(total).toBe(4096);
		} finally {
			await provider.close();
		}
	});

	it("still reports a provider that stops sending mid-body", async () => {
		const provider = await fakeProvider((_req, res) => {
			res.writeHead(200);
			res.write("z".repeat(1024));
			// ...and nothing more, without closing.
		});
		try {
			const stream = await s3At(provider.endpoint, 150).getStream("a.bin");
			await expect(drain(stream)).rejects.toMatchObject({
				code: "E_ARCHIVE_REQUEST_TIMEOUT",
			});
		} finally {
			await provider.close();
		}
	});

	it("lets an upload that keeps moving outlast the bound", async () => {
		// The transport stands in for the socket here: a kernel send buffer
		// on loopback swallows megabytes at once, which says nothing about
		// pacing. This one takes a slice every 20 ms, as a slow uplink would.
		let received = 0;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const body = init.body;
			if (!(body instanceof ReadableStream)) {
				throw new Error("expected the body to be handed over as a stream");
			}
			const reader = body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				await sleep(20);
			}
			return new Response(null, { status: 200 });
		});
		const body = Buffer.alloc(2 * 1024 * 1024, 1);
		const started = Date.now();
		await s3At("http://127.0.0.1:9", 100).put("big.bin", body);
		// 32 slices, 20 ms apart: several times the bound, never idle for it.
		expect(Date.now() - started).toBeGreaterThan(300);
		expect(received).toBe(body.length);
	});

	it("sends a sliced upload as one fixed-length request", async () => {
		const seen: http.IncomingHttpHeaders[] = [];
		let received = 0;
		const provider = await fakeProvider((req, res) => {
			seen.push(req.headers);
			req.on("data", (chunk: Buffer) => {
				received += chunk.length;
			});
			req.on("end", () => {
				res.writeHead(200);
				res.end();
			});
		});
		try {
			const body = Buffer.alloc(1024 * 1024, 1);
			await s3At(provider.endpoint, 1000).put("big.bin", body);
			expect(received).toBe(body.length);
			// Providers refuse a chunked PUT: the length is declared up front.
			expect(seen[0]?.["content-length"]).toBe(String(body.length));
			expect(seen[0]?.["transfer-encoding"]).toBeUndefined();
		} finally {
			await provider.close();
		}
	});

	it("still reports a provider that stops taking the upload", async () => {
		const provider = await fakeProvider((req) => {
			req.pause();
			// Never reads, never answers.
		});
		try {
			await expect(
				s3At(provider.endpoint, 150).put(
					"big.bin",
					Buffer.alloc(16 * 1024 * 1024),
				),
			).rejects.toMatchObject({ code: "E_ARCHIVE_REQUEST_TIMEOUT" });
		} finally {
			await provider.close();
		}
	});
});
