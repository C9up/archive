/// <reference lib="dom" />
// Uses the WHATWG fetch/streams globals, which live in the DOM lib even on
// Node. Referenced here so a consumer whose `lib` omits DOM still typechecks
// our sources.
/**
 * One request to a storage provider, bounded by an IDLE timeout.
 *
 * The bound has to catch a provider that stops answering, and nothing else.
 * A wall-clock signal on the whole exchange (`AbortSignal.timeout` handed to
 * `fetch`) also covers the body, in both directions: a 2 GB download piped to
 * a slow client, or a 5 MiB part sent over a slow uplink, failed once it had
 * been running for the configured time, however steadily it was progressing.
 *
 * So the timer measures only the time spent WAITING ON THE PROVIDER:
 *
 *   - while the request body goes out, it restarts every time the transport
 *     asks for the next slice (the provider is accepting bytes);
 *   - while the response headers are awaited, it runs;
 *   - while the response body is read, it runs only between asking the
 *     provider for a chunk and receiving it. A consumer that reads slowly is
 *     not the provider stalling, so the clock is stopped while the consumer
 *     holds a chunk.
 */

import type { Exception } from "@c9up/flare";
import { E_ARCHIVE_REQUEST_TIMEOUT } from "./errors.js";

/** Size of the slices an outgoing body is handed to the transport in. */
const UPLOAD_SLICE = 64 * 1024;

/** Statuses a `Response` may not be constructed with a body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function timeoutError(ms: number): Exception {
	return new E_ARCHIVE_REQUEST_TIMEOUT([ms]);
}

/**
 * `fetch` with an idle timeout of `ms` (0 or less disables it).
 *
 * The returned response's body, when it has one, is a stream that keeps the
 * same idle bound while it is read; a stall surfaces as
 * `E_ARCHIVE_REQUEST_TIMEOUT` from the read, not as a hang.
 */
export async function fetchWithIdleTimeout(
	url: string,
	init: RequestInit,
	ms: number,
): Promise<Response> {
	if (ms <= 0) return fetch(url, init);

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const stop = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const arm = (): void => {
		stop();
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort(timeoutError(ms));
		}, ms);
	};

	// `duplex` is what Node's fetch requires for a stream body; the DOM lib's
	// RequestInit predates it.
	const request: RequestInit & { duplex?: "half" } = {
		...init,
		signal: controller.signal,
	};
	const body = init.body;
	if (body instanceof Uint8Array && body.byteLength > UPLOAD_SLICE) {
		// Handed over slice by slice, so each request for the next slice is
		// evidence the provider is still taking bytes. The declared length
		// keeps the request a plain fixed-length one: providers refuse a
		// chunked PUT, and a stream body would otherwise be sent chunked.
		const headers = new Headers(init.headers);
		headers.set("content-length", String(body.byteLength));
		let offset = 0;
		request.headers = headers;
		request.body = new ReadableStream<Uint8Array>(
			{
				pull(stream) {
					arm();
					const end = Math.min(offset + UPLOAD_SLICE, body.byteLength);
					stream.enqueue(body.subarray(offset, end));
					offset = end;
					if (offset >= body.byteLength) stream.close();
				},
			},
			{ highWaterMark: 0 },
		);
		request.duplex = "half";
	}

	arm();
	let response: Response;
	try {
		response = await fetch(url, request);
	} catch (err) {
		stop();
		if (timedOut) throw timeoutError(ms);
		throw err;
	}
	stop();

	const source = response.body;
	// A null-body status cannot be rebuilt with a body, and has none to read.
	if (source === null || NULL_BODY_STATUSES.has(response.status)) {
		return response;
	}
	// Locked on the first read only: a caller that never reads the body (a
	// DELETE, a HEAD-like check) leaves it exactly as fetch returned it.
	let locked: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const reader = (): ReadableStreamDefaultReader<Uint8Array> => {
		locked ??= source.getReader();
		return locked;
	};
	const guarded = new ReadableStream<Uint8Array>(
		{
			async pull(stream) {
				const upstream = reader();
				arm();
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await upstream.read();
				} catch (err) {
					stop();
					if (timedOut) throw timeoutError(ms);
					throw err;
				}
				stop();
				if (chunk.done) stream.close();
				else stream.enqueue(chunk.value);
			},
			cancel(reason) {
				stop();
				return reader().cancel(reason);
			},
		},
		// Pull only on demand: the clock must not run on read-ahead the
		// consumer has not asked for.
		{ highWaterMark: 0 },
	);
	return new Response(guarded, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * Bytes as a request body, without copying when they can be shared.
 *
 * A Node `Buffer` may sit on a `SharedArrayBuffer`, which a request body
 * cannot be: the view is reused as is over a plain `ArrayBuffer`, and copied
 * only otherwise.
 */
export function requestBody(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const { buffer } = bytes;
	return buffer instanceof ArrayBuffer
		? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
		: new Uint8Array(bytes);
}
