/**
 * S3Driver — S3-compatible cloud storage (AWS S3, Cloudflare R2, MinIO).
 *
 * Uses fetch API — no external SDK dependency.
 * Implements the StorageDriver interface.
 *
 * @implements MISS-24
 */

import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ArchiveError } from "./errors.js";
import { assertValidExpiry, DEFAULT_EXPIRES_IN } from "./expiry.js";
import type {
	Metadata,
	PutStreamOptions,
	SignedUrlOptions,
	StorageDriver,
	StorageEntry,
	Visibility,
} from "./StorageManager.js";

/** AWS minimum for a non-final multipart part. */
const S3_MULTIPART_PART_SIZE = 5 * 1024 * 1024;

/**
 * AWS SigV4 strict URI encoding: RFC3986 unreserved set only
 * (`A-Z a-z 0-9 - . _ ~`). `encodeURIComponent` leaves `! * ' ( )`
 * unencoded, but AWS canonicalisation requires them encoded — a
 * signature derived with `encodeURIComponent` alone will silently
 * mismatch for keys containing those characters.
 */
function s3StrictEncode(str: string): string {
	return encodeURIComponent(str).replace(
		/[!*'()]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * URI-encode an S3 object key per AWS SigV4 rules: encode each path segment
 * individually but preserve `/` separators. Handles spaces, unicode, `#`, `?`, `%`
 * as well as the strict AWS set (`! * ' ( )`).
 */
function s3EncodeKey(key: string): string {
	return key.split("/").map(s3StrictEncode).join("/");
}

export interface S3Config {
	bucket: string;
	region?: string;
	endpoint?: string;
	accessKeyId: string;
	secretAccessKey: string;
	publicUrl?: string;
}

export class S3Driver implements StorageDriver {
	#config: S3Config;
	#endpoint: string;

	constructor(config: S3Config) {
		// Require at least one of `region` or `endpoint`. Defaulting to
		// `us-east-1` silently would mis-sign requests against a
		// non-AWS-default region (e.g. eu-west-3) and produce signature
		// errors only at runtime — much better to fail fast here.
		if (!config.endpoint && !config.region) {
			throw new Error(
				"S3Driver: either `region` or `endpoint` is required. Pass `region` for AWS S3, or `endpoint` for S3-compatible services (MinIO, R2, etc.).",
			);
		}
		this.#config = config;
		const rawEndpoint =
			config.endpoint ?? `https://s3.${config.region}.amazonaws.com`;
		// Strip any trailing slash: a user-configured endpoint like
		// `https://minio.local/` would otherwise produce `//bucket/key`
		// URLs that real S3/MinIO reject AND whose canonical URI used
		// for signing would no longer match the request URL.
		this.#endpoint = rawEndpoint.replace(/\/+$/, "");
	}

	async put(filePath: string, content: Buffer | string): Promise<void> {
		const body = typeof content === "string" ? Buffer.from(content) : content;
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}`;
		const headers = this.#signRequest({ method: "PUT", key: filePath, body });

		const res = await fetch(url, {
			method: "PUT",
			headers,
			body: body as BodyInit,
		});
		if (!res.ok) {
			throw new Error(`S3 PUT failed (${res.status}): ${await res.text()}`);
		}
	}

	async putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		options?: PutStreamOptions,
	): Promise<void> {
		const { contentType, contentLength } = options ?? {};
		// Small-file fast path: known length ≤ 5 MiB → buffer & single PUT.
		if (
			contentLength !== undefined &&
			contentLength <= S3_MULTIPART_PART_SIZE
		) {
			const body = await collectToBuffer(readable, contentLength);
			const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}`;
			const signed = this.#signRequest({ method: "PUT", key: filePath, body });
			// content-type kept UNSIGNED — undici may rewrite it for
			// non-Buffer bodies, which would invalidate a signed value.
			const headers: Record<string, string> = contentType
				? { ...signed, "content-type": contentType }
				: signed;
			const res = await fetch(url, {
				method: "PUT",
				headers,
				body: body as BodyInit,
			});
			if (!res.ok) {
				throw new Error(`S3 PUT failed (${res.status}): ${await res.text()}`);
			}
			return;
		}
		// Multipart path: unknown length OR > 5 MiB.
		//
		// Peek the first chunk before initiating: strict S3-compatible
		// servers reject multipart uploads whose (only) part is empty,
		// and spinning up the 3-step dance for a 0-byte object is waste
		// anyway. Fall through to a direct single-PUT in that case.
		const chunks = chunkStream(readable, S3_MULTIPART_PART_SIZE);
		const iterator = chunks[Symbol.asyncIterator]();
		const firstChunk = await iterator.next();
		if (firstChunk.done) {
			await this.put(filePath, Buffer.alloc(0));
			return;
		}
		const uploadId = await this.#initiateMultipartUpload(filePath, contentType);
		const parts: Array<{ partNumber: number; etag: string }> = [];
		try {
			let partNumber = 1;
			let chunk: Buffer | undefined = firstChunk.value;
			while (chunk !== undefined) {
				const etag = await this.#uploadPart(
					filePath,
					uploadId,
					partNumber,
					chunk,
					contentType,
				);
				parts.push({ partNumber, etag });
				partNumber++;
				const next = await iterator.next();
				chunk = next.done ? undefined : next.value;
			}
			await this.#completeMultipartUpload(filePath, uploadId, parts);
		} catch (err) {
			// Best-effort abort so we don't leak staged parts. The
			// original error is what bubbles up.
			await this.#abortMultipartUpload(filePath, uploadId).catch(() => {});
			throw err;
		}
	}

	async getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}`;
		const headers = this.#signRequest({ method: "GET", key: filePath });
		const res = await fetch(url, { method: "GET", headers });
		if (res.status === 404) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`S3 object does not exist at path '${filePath}'`,
				{
					hint: "Confirm the bucket + key and that the object was put() first.",
				},
			);
		}
		if (!res.ok) throw new Error(`S3 GET failed (${res.status})`);
		if (res.body === null) {
			// Edge case: 200 with no body. Return an empty readable.
			return Readable.from(Buffer.alloc(0));
		}
		// Node's `Readable.fromWeb` expects the `node:stream/web` variant,
		// while `fetch().body` gives the lib.dom variant. Runtime shape is
		// identical — the difference is only in TS lib typings. A single
		// cast to the node-side type is enough (no `unknown` pivot).
		return Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>);
	}

	async get(filePath: string): Promise<Buffer | null> {
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}`;
		const headers = this.#signRequest({ method: "GET", key: filePath });

		const res = await fetch(url, { method: "GET", headers });
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`S3 GET failed (${res.status})`);

		const arrayBuffer = await res.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}

	async delete(filePath: string): Promise<boolean> {
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}`;
		const headers = this.#signRequest({ method: "DELETE", key: filePath });

		const res = await fetch(url, { method: "DELETE", headers });
		return res.ok || res.status === 204;
	}

	async exists(filePath: string): Promise<boolean> {
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}`;
		const headers = this.#signRequest({ method: "HEAD", key: filePath });

		const res = await fetch(url, { method: "HEAD", headers });
		return res.ok;
	}

	publicUrl(filePath: string): string {
		if (this.#config.publicUrl) {
			// Strip trailing slash to avoid `cdn.example.com//key` artifacts.
			const publicRoot = this.#config.publicUrl.replace(/\/+$/, "");
			return `${publicRoot}/${s3EncodeKey(filePath)}`;
		}
		return `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}`;
	}

	async url(filePath: string): Promise<string> {
		const meta = await this.getMetadata(filePath);
		if (meta.visibility === "public") return this.publicUrl(filePath);
		return this.getSignedUrl(filePath);
	}

	async getMetadata(filePath: string): Promise<Metadata> {
		// HEAD for size / mime / lastModified / etag.
		const headUrl = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}`;
		const headHeaders = this.#signRequest({ method: "HEAD", key: filePath });
		const headRes = await fetch(headUrl, {
			method: "HEAD",
			headers: headHeaders,
		});
		if (headRes.status === 404) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`S3 object does not exist at path '${filePath}'`,
				{
					hint: "Confirm the bucket + key and that the object was put() first.",
				},
			);
		}
		if (!headRes.ok) {
			throw new Error(`S3 HEAD failed (${headRes.status})`);
		}
		const size = Number.parseInt(
			headRes.headers.get("content-length") ?? "0",
			10,
		);
		const mimeType =
			headRes.headers.get("content-type") ?? "application/octet-stream";
		const lastModifiedHeader = headRes.headers.get("last-modified");
		const lastModified = lastModifiedHeader
			? new Date(lastModifiedHeader)
			: new Date(0);
		const rawEtag = headRes.headers.get("etag") ?? "";
		// Strip surrounding quotes, preserving any `W/` weak prefix.
		// The naive `/^"|"$/g` would only strip the trailing `"` from
		// `W/"abc"`, leaving `W/"abc` — a malformed etag.
		const etag = rawEtag.replace(/^(W\/)?"(.*)"$/, "$1$2");

		// GET ?acl to determine visibility. AllUsers READ grant → public.
		const aclUrl = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}?acl`;
		const aclHeaders = this.#signRequest({
			method: "GET",
			key: filePath,
			queryParams: [["acl", ""]],
		});
		const aclRes = await fetch(aclUrl, { method: "GET", headers: aclHeaders });
		let visibility: Visibility = "private";
		if (aclRes.ok) {
			const xml = await aclRes.text();
			if (isPublicAcl(xml)) visibility = "public";
		}
		// Non-2xx on ACL (e.g. 403 on a bucket without permission) falls
		// through to `private` — the safer default.

		return { size, mimeType, lastModified, etag, visibility };
	}

	async setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		const cannedAcl = visibility === "public" ? "public-read" : "private";
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}?acl`;
		const headers = this.#signRequest({
			method: "PUT",
			key: filePath,
			queryParams: [["acl", ""]],
			extraHeaders: { "x-amz-acl": cannedAcl },
		});
		const res = await fetch(url, { method: "PUT", headers });
		if (!res.ok) {
			throw new Error(`S3 PUT failed (${res.status}): ${await res.text()}`);
		}
	}

	/**
	 * Generate a presigned GET URL per AWS SigV4 query-parameter spec.
	 *
	 * The returned URL always targets the **signing endpoint**
	 * (`config.endpoint` or the derived AWS endpoint), *not*
	 * `config.publicUrl` — presigned URLs only validate against the
	 * host that signed them. For a CDN-fronted bucket, serve unsigned
	 * reads via {@link url} instead of presigning.
	 *
	 * Canonical differences from header-signed requests:
	 *   - SignedHeaders is `host` only (no `x-amz-date`/content-hash).
	 *   - Payload hash is the literal `UNSIGNED-PAYLOAD`.
	 *   - Credentials and expiry live in query params, not headers.
	 */
	getSignedUrl(filePath: string, options?: SignedUrlOptions): string {
		const expiresIn = options?.expiresIn ?? DEFAULT_EXPIRES_IN;
		assertValidExpiry(expiresIn);

		const dateStamp = amzDateNow();
		const shortDate = dateStamp.slice(0, 8);
		const region = this.#config.region ?? "us-east-1";
		const service = "s3";
		const scope = `${shortDate}/${region}/${service}/aws4_request`;
		const credential = `${this.#config.accessKeyId}/${scope}`;

		// Canonical query params — names MUST be URI-encoded and the
		// whole string sorted by key before signing. Every `X-Amz-*`
		// key is already safe, so we only URI-encode values.
		const queryParams: Array<[string, string]> = [
			["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
			["X-Amz-Credential", credential],
			["X-Amz-Date", dateStamp],
			["X-Amz-Expires", String(expiresIn)],
			["X-Amz-SignedHeaders", "host"],
		];
		const canonicalQs = queryParams
			.slice()
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([k, v]) => `${k}=${s3StrictEncode(v)}`)
			.join("&");

		const host = new URL(this.#endpoint).host;
		const canonicalRequest = [
			"GET",
			`/${this.#config.bucket}/${s3EncodeKey(filePath)}`,
			canonicalQs,
			`host:${host}\n`,
			"host",
			"UNSIGNED-PAYLOAD",
		].join("\n");

		const stringToSign = [
			"AWS4-HMAC-SHA256",
			dateStamp,
			scope,
			createHash("sha256").update(canonicalRequest).digest("hex"),
		].join("\n");

		const signingKey = this.#derivingKey(shortDate, region, service);
		const signature = createHmac("sha256", signingKey)
			.update(stringToSign)
			.digest("hex");

		return `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}?${canonicalQs}&X-Amz-Signature=${signature}`;
	}

	async copy(from: string, to: string): Promise<void> {
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(to)}`;
		const copySource = `/${this.#config.bucket}/${s3EncodeKey(from)}`;
		const headers = this.#signRequest({
			method: "PUT",
			key: to,
			extraHeaders: { "x-amz-copy-source": copySource },
		});
		const res = await fetch(url, { method: "PUT", headers });
		if (!res.ok) {
			const body = await res.text();
			if (/\bNoSuchKey\b/.test(body) || res.status === 404) {
				throw new ArchiveError(
					"ARCHIVE_NOT_FOUND",
					`S3 copy source does not exist at path '${from}'`,
					{ hint: "Confirm the source object was put() first." },
				);
			}
			throw new Error(`S3 COPY failed (${res.status}): ${body}`);
		}
		// S3 CopyObject can return 200 + an XML <Error> body (streaming
		// copies that fail mid-flight). Matches the same pattern handled
		// in #completeMultipartUpload — don't silently succeed.
		const body = await res.text();
		if (/<Error>/i.test(body)) {
			throw new Error(`S3 COPY returned error body: ${body}`);
		}
	}

	async move(from: string, to: string): Promise<void> {
		// Non-atomic: copy then delete. An observer between the two
		// steps sees both objects — documented in the interface JSDoc.
		await this.copy(from, to);
		await this.delete(from);
	}

	async *list(prefix: string): AsyncIterable<StorageEntry> {
		let continuationToken: string | undefined;
		do {
			const qp: Array<[string, string]> = [
				["list-type", "2"],
				["prefix", prefix],
			];
			if (continuationToken) qp.push(["continuation-token", continuationToken]);
			const canonicalQs = qp
				.slice()
				.sort((a, b) => (a[0] < b[0] ? -1 : 1))
				.map(([k, v]) => `${k}=${s3StrictEncode(v)}`)
				.join("&");
			const url = `${this.#endpoint}/${this.#config.bucket}?${canonicalQs}`;
			const headers = this.#signRequest({
				method: "GET",
				key: "",
				queryParams: qp,
			});
			const res = await fetch(url, { method: "GET", headers });
			if (!res.ok) {
				throw new Error(`S3 LIST failed (${res.status}): ${await res.text()}`);
			}
			const xml = await res.text();
			// Parse each <Contents> block independently, then extract
			// each field by its own regex. Some S3-compatible servers
			// (R2, MinIO variants) emit fields in different orders than
			// AWS — an ordered regex would yield corrupt values silently.
			const blockRe = /<Contents>([\s\S]*?)<\/Contents>/g;
			let blockMatch: RegExpExecArray | null = blockRe.exec(xml);
			while (blockMatch !== null) {
				const block = blockMatch[1] ?? "";
				const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? "";
				const sizeRaw = block.match(/<Size>([^<]+)<\/Size>/)?.[1] ?? "0";
				const lm = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1];
				yield {
					path: key,
					size: Number.parseInt(sizeRaw, 10),
					lastModified: lm ? new Date(lm) : new Date(0),
				};
				blockMatch = blockRe.exec(xml);
			}
			const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
			const tokenMatch = xml.match(
				/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
			);
			continuationToken = truncated && tokenMatch ? tokenMatch[1] : undefined;
		} while (continuationToken);
	}

	/**
	 * Sign a request with AWS Signature V4 (header-signed flow).
	 *
	 * `queryParams` appear both in the canonical query string (sorted,
	 * strict-encoded, empty values kept as `k=`) and on the actual
	 * request URL. Use for subresources (`acl`, `uploads`) and for
	 * multi-value queries (`partNumber=N&uploadId=X`). `extraHeaders`
	 * are merged into the signed-headers set — use for `x-amz-acl` and
	 * friends so the server verifies them against the signature.
	 *
	 * For production, consider using @aws-sdk/signature-v4 for full compliance.
	 */
	#signRequest(opts: {
		method: string;
		key: string;
		body?: Buffer;
		queryParams?: Array<[string, string]>;
		extraHeaders?: Record<string, string>;
	}): Record<string, string> {
		const { method, key, body, queryParams, extraHeaders } = opts;
		const dateStamp = amzDateNow();
		const shortDate = dateStamp.slice(0, 8);
		const region = this.#config.region ?? "us-east-1";
		const service = "s3";

		const payloadHash = createHash("sha256")
			.update(body ?? "")
			.digest("hex");

		// `content-length` is intentionally NOT signed. undici (Node's
		// fetch implementation) sets / overrides the Content-Length
		// header itself when the body is a Buffer, which would cause a
		// signature mismatch if we included it in SignedHeaders. S3
		// accepts unsigned Content-Length — SigV4 only requires `host`,
		// `x-amz-date`, and `x-amz-content-sha256` to be signed.
		const headers: Record<string, string> = {
			host: new URL(this.#endpoint).host,
			"x-amz-date": dateStamp,
			"x-amz-content-sha256": payloadHash,
			...(extraHeaders ?? {}),
		};

		// Canonical request — header names are lowercased for signing
		// (AWS requirement); the actual wire values stay as-provided.
		const sortedHeaderKeys = Object.keys(headers).sort();
		const signedHeaders = sortedHeaderKeys.join(";");
		const canonicalHeaders = sortedHeaderKeys
			.map((k) => `${k}:${headers[k]}\n`)
			.join("");
		// Canonical query string: sorted by key, strict-encoded values,
		// empty values kept as `k=` (AWS canonical form for bare
		// subresources like `?acl` and `?uploads`).
		const canonicalQuery = (queryParams ?? [])
			.slice()
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([k, v]) => `${k}=${s3StrictEncode(v)}`)
			.join("&");
		const canonicalRequest = [
			method,
			`/${this.#config.bucket}/${s3EncodeKey(key)}`,
			canonicalQuery,
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join("\n");

		// String to sign
		const scope = `${shortDate}/${region}/${service}/aws4_request`;
		const stringToSign = [
			"AWS4-HMAC-SHA256",
			dateStamp,
			scope,
			createHash("sha256").update(canonicalRequest).digest("hex"),
		].join("\n");

		const signingKey = this.#derivingKey(shortDate, region, service);
		const signature = createHmac("sha256", signingKey)
			.update(stringToSign)
			.digest("hex");

		headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.#config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

		return headers;
	}

	/** Initiate a multipart upload. Returns the server-assigned UploadId. */
	async #initiateMultipartUpload(
		filePath: string,
		contentType?: string,
	): Promise<string> {
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}?uploads`;
		const signed = this.#signRequest({
			method: "POST",
			key: filePath,
			queryParams: [["uploads", ""]],
		});
		const headers: Record<string, string> = contentType
			? { ...signed, "content-type": contentType }
			: signed;
		const res = await fetch(url, { method: "POST", headers });
		if (!res.ok) {
			throw new Error(
				`S3 multipart initiate failed (${res.status}): ${await res.text()}`,
			);
		}
		const xml = await res.text();
		const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
		// Capture group 1 must be defined because the regex includes it
		// and `match` returned non-null. If the regex ever changes to
		// something with optional groups, the `match[1] === undefined`
		// path must be handled explicitly — not silently defaulted.
		if (!match || match[1] === undefined) {
			throw new Error(
				`S3 multipart initiate: UploadId missing from response: ${xml}`,
			);
		}
		return match[1];
	}

	/** Upload a single part. Returns the server-reported ETag (quotes kept). */
	async #uploadPart(
		filePath: string,
		uploadId: string,
		partNumber: number,
		body: Buffer,
		contentType?: string,
	): Promise<string> {
		const queryParams: Array<[string, string]> = [
			["partNumber", String(partNumber)],
			["uploadId", uploadId],
		];
		const qs = `partNumber=${partNumber}&uploadId=${s3StrictEncode(uploadId)}`;
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}?${qs}`;
		const signed = this.#signRequest({
			method: "PUT",
			key: filePath,
			body,
			queryParams,
		});
		const headers: Record<string, string> = contentType
			? { ...signed, "content-type": contentType }
			: signed;
		const res = await fetch(url, {
			method: "PUT",
			headers,
			body: body as BodyInit,
		});
		if (!res.ok) {
			throw new Error(
				`S3 UploadPart failed part=${partNumber} (${res.status}): ${await res.text()}`,
			);
		}
		const etag = res.headers.get("etag");
		if (!etag) {
			throw new Error(
				`S3 UploadPart part=${partNumber}: ETag missing from response`,
			);
		}
		// Keep the quotes — CompleteMultipartUpload XML requires the
		// ETag value exactly as S3 returned it.
		return etag;
	}

	/** Finalise a multipart upload with the collected part ETags. */
	async #completeMultipartUpload(
		filePath: string,
		uploadId: string,
		parts: Array<{ partNumber: number; etag: string }>,
	): Promise<void> {
		const xmlBody = Buffer.from(
			`<CompleteMultipartUpload>${parts
				.map(
					(p) =>
						`<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`,
				)
				.join("")}</CompleteMultipartUpload>`,
		);
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}?uploadId=${s3StrictEncode(uploadId)}`;
		const signed = this.#signRequest({
			method: "POST",
			key: filePath,
			body: xmlBody,
			queryParams: [["uploadId", uploadId]],
		});
		const res = await fetch(url, {
			method: "POST",
			headers: signed,
			body: xmlBody as BodyInit,
		});
		if (!res.ok) {
			throw new Error(
				`S3 CompleteMultipartUpload failed (${res.status}): ${await res.text()}`,
			);
		}
		// S3 can return 200 + an XML error body (!) — detect via
		// <Error> root element and throw.
		const text = await res.text();
		if (
			/^\s*<\?xml[^?]*\?>\s*<Error>/i.test(text) ||
			/^\s*<Error>/.test(text)
		) {
			throw new Error(
				`S3 CompleteMultipartUpload returned Error body: ${text}`,
			);
		}
	}

	/** Release a multipart upload's staged parts. Best-effort. */
	async #abortMultipartUpload(
		filePath: string,
		uploadId: string,
	): Promise<void> {
		const url = `${this.#endpoint}/${this.#config.bucket}/${s3EncodeKey(filePath)}?uploadId=${s3StrictEncode(uploadId)}`;
		const headers = this.#signRequest({
			method: "DELETE",
			key: filePath,
			queryParams: [["uploadId", uploadId]],
		});
		await fetch(url, { method: "DELETE", headers });
	}

	/**
	 * Derive the SigV4 signing key (k_date → k_region → k_service →
	 * k_signing). Extracted so `#signRequest` and `getSignedUrl` share
	 * the same chain without copy-paste drift.
	 */
	#derivingKey(shortDate: string, region: string, service: string): Buffer {
		const kDate = createHmac("sha256", `AWS4${this.#config.secretAccessKey}`)
			.update(shortDate)
			.digest();
		const kRegion = createHmac("sha256", kDate).update(region).digest();
		const kService = createHmac("sha256", kRegion).update(service).digest();
		return createHmac("sha256", kService).update("aws4_request").digest();
	}
}

/** Returns the current instant in AWS basic-ISO8601 form: `YYYYMMDDTHHMMSSZ`. */
function amzDateNow(): string {
	return `${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

/**
 * Drain a readable into a single Buffer, capped at `maxBytes`. Throws
 * if the stream yields more than that — caller declared a contentLength
 * and we refuse to silently over-buffer.
 */
/**
 * Type guard for any readable that exposes `destroy()` (Node streams
 * do; a generic `ReadableStream` iterable doesn't). Lets us release
 * file descriptors / sockets without an `as unknown as T` cast.
 */
function hasDestroy(x: unknown): x is { destroy(err?: Error): void } {
	return (
		typeof x === "object" &&
		x !== null &&
		typeof (x as { destroy?: unknown }).destroy === "function"
	);
}

async function collectToBuffer(
	readable: NodeJS.ReadableStream,
	maxBytes: number,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of readable) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		total += buf.length;
		if (total > maxBytes) {
			// Destroy the upstream so FDs / sockets don't leak. Without
			// this, an `fs.createReadStream` or `IncomingMessage` would
			// stay open for the lifetime of the process.
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
 * Async-iterable that yields Buffers of exactly `partSize` bytes (last
 * one may be smaller). Used to slice a stream into S3 multipart parts.
 *
 * **Backpressure.** Memory usage is bounded by `partSize + readable`'s
 * own `highWaterMark`. The `for await` loop pulls from `readable` only
 * when the consumer has finished awaiting the previous yield, so a slow
 * consumer naturally throttles a fast producer through Node's stream
 * pause/resume protocol — `pending` is drained to a single yield before
 * the loop pulls the next chunk. Pass a `Readable` with a tighter
 * `highWaterMark` to lower the peak. Pre-buffered streams (e.g.
 * `Readable.from(buffer)`) bypass this and surface their entire payload
 * in one tick; for those, expect peak ≈ `payload + partSize`.
 */
async function* chunkStream(
	readable: NodeJS.ReadableStream,
	partSize: number,
): AsyncIterable<Buffer> {
	let pending: Buffer[] = [];
	let pendingSize = 0;
	for await (const chunk of readable) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
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

/**
 * Quick-and-narrow ACL XML classification: treat the object as public
 * iff the ACL grants `READ` to the `AllUsers` group. Anything else
 * (specific-user grants, `AuthenticatedUsers`, no Grant block) maps to
 * `private`. Good enough for the two-state visibility API — upgrading
 * to a real XML parser would just add a dependency without shifting
 * the result.
 */
function isPublicAcl(xml: string): boolean {
	// Normalise whitespace to keep the regex tractable across S3/MinIO/R2
	// variants that differ in indentation and attribute order.
	const flat = xml.replace(/\s+/g, " ");
	return /<Grant>[^<]*<Grantee[^>]*>[^<]*<URI>[^<]*AllUsers<\/URI>[^<]*<\/Grantee>[^<]*<Permission>\s*READ\s*<\/Permission>/i.test(
		flat,
	);
}
