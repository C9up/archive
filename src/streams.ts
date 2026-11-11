/**
 * Stream helpers shared by the cloud drivers' uploads.
 */

/** A chunk of a Node readable as bytes (string chunks are UTF-8). */
function toBuffer(chunk: unknown): Buffer {
	if (Buffer.isBuffer(chunk)) return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk);
	return Buffer.from(String(chunk));
}

/**
 * Type guard for any readable that exposes `destroy()` (Node streams do; a
 * generic iterable does not), so file descriptors and sockets can be released
 * without a cast.
 */
function hasDestroy(x: unknown): x is { destroy(err?: Error): void } {
	return (
		typeof x === "object" &&
		x !== null &&
		"destroy" in x &&
		typeof x.destroy === "function"
	);
}

/**
 * Drain a readable into a single Buffer, capped at `maxBytes`. Throws if the
 * stream yields more than that — the caller declared a length and we refuse
 * to silently over-buffer — after destroying the upstream so its descriptor
 * or socket does not leak.
 */
export async function collectToBuffer(
	readable: NodeJS.ReadableStream,
	maxBytes: number,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of readable) {
		const buf = toBuffer(chunk);
		total += buf.length;
		if (total > maxBytes) {
			if (hasDestroy(readable)) readable.destroy();
			throw new Error(
				`putStream: readable exceeded declared contentLength (${total} > ${maxBytes})`,
			);
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks, total);
}

/**
 * Async-iterable that yields Buffers of exactly `partSize` bytes (the last
 * one may be smaller). Used to slice a stream into multipart parts or
 * resumable-upload chunks.
 *
 * **Backpressure.** Memory usage is bounded by `partSize + readable`'s own
 * `highWaterMark`. The `for await` loop pulls from `readable` only when the
 * consumer has finished awaiting the previous yield, so a slow consumer
 * naturally throttles a fast producer through Node's stream pause/resume
 * protocol. Pre-buffered streams (e.g. `Readable.from(buffer)`) bypass this
 * and surface their entire payload in one tick; for those, expect peak ≈
 * `payload + partSize`.
 */
export async function* chunkStream(
	readable: NodeJS.ReadableStream,
	partSize: number,
): AsyncIterable<Buffer> {
	let pending: Buffer[] = [];
	let pendingSize = 0;
	for await (const chunk of readable) {
		const buf = toBuffer(chunk);
		pending.push(buf);
		pendingSize += buf.length;
		while (pendingSize >= partSize) {
			const joined = Buffer.concat(pending, pendingSize);
			yield joined.subarray(0, partSize);
			const leftover = joined.subarray(partSize);
			pending = leftover.length > 0 ? [leftover] : [];
			pendingSize = leftover.length;
		}
	}
	if (pendingSize > 0) {
		yield Buffer.concat(pending, pendingSize);
	}
}
