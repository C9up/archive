/// <reference lib="dom" />
// Uses the WHATWG fetch/Blob globals, which live in the DOM lib even on
// Node. Referenced here so a consumer whose `lib` omits DOM still
// typechecks our sources.
/**
 * GcsDriver — Google Cloud Storage driver.
 *
 * Uses the fetch API + a hand-rolled V4 signer — no external SDK.
 * Implements the full StorageDriver contract: put/get/delete/exists,
 * url/publicUrl, getSignedUrl, getMetadata, setVisibility, putStream,
 * getStream.
 *
 * @implements MISS-24
 */

import { createHash, createSign } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ArchiveError } from "./errors.js";
import {
	assertValidExpiry,
	DEFAULT_EXPIRES_IN,
	parseExpiry,
} from "./expiry.js";
import { normalizeKey, normalizePrefix } from "./keys.js";
import { inferMimeType } from "./mime-types.js";
import { DriveDirectory, DriveFile } from "./objects.js";
import { fetchWithIdleTimeout, requestBody } from "./provider-fetch.js";
import type {
	ListAllOptions,
	ListAllResult,
	Metadata,
	PutStreamOptions,
	SignedUrlOptions,
	StorageDriver,
	StorageEntry,
	Visibility,
	WriteOptions,
} from "./StorageManager.js";
import { chunkStream, collectToBuffer } from "./streams.js";

/** GCS V4 strict URL encoding — identical to AWS's RFC3986-unreserved
 *  set. Duplicated from `S3Driver.ts` on purpose: per cerebrum rule,
 *  drivers do not share helpers even within the package. */
function gcsStrictEncode(str: string): string {
	return encodeURIComponent(str).replace(
		/[!*'()]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * Encode an object path segment-by-segment, preserving `/`.
 *
 * This is the form the XML download endpoint and the V4 signing canonical
 * resource want: the signing rules list the characters to percent-encode and
 * `/` is not among them, so encoding it there would break every signature.
 */
function gcsEncodeKey(key: string): string {
	return normalizeKey(key).split("/").map(gcsStrictEncode).join("/");
}

/**
 * Encode an object NAME for the JSON API, where the whole name is one path
 * segment and `/` is part of it.
 *
 * The JSON API addresses `…/b/{bucket}/o/{object}`; an unencoded slash there
 * makes the request address a different resource, which answers 404. Since
 * `exists()` and `delete()` read a 404 as "not there", every object inside a
 * prefix would silently look absent.
 *
 * Both encoders normalise the key first (see `keys.ts`): every object URL is
 * built through one of them, so a `..` never reaches the provider even when
 * the driver is used without a manager in front.
 */
function gcsEncodeObjectName(key: string): string {
	return gcsStrictEncode(normalizeKey(key));
}

/** Base64url encode a Buffer (RFC 4648 §5) — no `=` padding, `-` / `_`
 *  alphabet. Required by JWT. */
function base64url(buf: Buffer): string {
	return buf
		.toString("base64")
		.replace(/=+$/, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

export interface GcsServiceAccount {
	client_email: string;
	private_key: string;
	project_id?: string;
}

export interface GcsConfig {
	bucket: string;
	serviceAccount: GcsServiceAccount;
	/** Optional CDN prefix for public URLs (e.g. `https://cdn.example.com`). */
	publicUrl?: string;
	/**
	 * How long the provider may stay silent during one request, in ms.
	 * Default 30 000.
	 *
	 * An idle bound, not a deadline: it runs while the provider is awaited
	 * (taking the request body, sending headers, sending the next chunk), so a
	 * long transfer that keeps moving is never cut. Without a bound a hung
	 * connection never settles: the handler awaiting it waits forever, and
	 * enough of them stop the server from serving. Set 0 to disable, which
	 * only makes sense behind an outer timeout.
	 */
	requestTimeoutMs?: number;
}

const GCS_API_ROOT = "https://storage.googleapis.com";
const GCS_UPLOAD_ROOT = "https://storage.googleapis.com/upload/storage/v1";
const GCS_META_ROOT = "https://storage.googleapis.com/storage/v1";
const GCS_OAUTH_URL = "https://oauth2.googleapis.com/token";
const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

/**
 * Size of one resumable-upload chunk: 8 MiB. Every chunk but the last must be
 * a multiple of 256 KiB, and the upload holds at most two in memory.
 */
const GCS_RESUMABLE_CHUNK = 32 * 256 * 1024;

export class GcsDriver implements StorageDriver {
	/**
	 * One request to the provider, bounded by {@link GcsConfig.requestTimeoutMs}
	 * as an idle timeout (see `provider-fetch.ts`): a hung connection surfaces
	 * as an error the caller can retry, a long transfer that keeps moving does
	 * not.
	 */
	#fetch(url: string, init: RequestInit = {}): Promise<Response> {
		return fetchWithIdleTimeout(
			url,
			init,
			this.#config.requestTimeoutMs ?? 30_000,
		);
	}

	#config: GcsConfig;
	#cachedToken: { value: string; expiresAt: number } | null = null;

	constructor(config: GcsConfig) {
		if (!config.bucket) {
			throw new Error("GcsDriver: `bucket` is required.");
		}
		if (
			!config.serviceAccount?.client_email ||
			!config.serviceAccount?.private_key
		) {
			throw new Error(
				"GcsDriver: `serviceAccount.client_email` and `serviceAccount.private_key` are required.",
			);
		}
		this.#config = config;
	}

	async put(
		filePath: string,
		content: Buffer | string,
		options?: WriteOptions,
	): Promise<void> {
		const body = typeof content === "string" ? Buffer.from(content) : content;
		const url = `${GCS_UPLOAD_ROOT}/b/${this.#config.bucket}/o?uploadType=media&name=${gcsEncodeObjectName(filePath)}`;
		const token = await this.#getAccessToken();
		const mime =
			options?.contentType ??
			(inferMimeType(extFromPath(filePath)) || "application/octet-stream");
		const headers: Record<string, string> = {
			authorization: `Bearer ${token}`,
			"content-type": mime,
		};
		if (options?.cacheControl) headers["cache-control"] = options.cacheControl;
		if (options?.contentDisposition) {
			headers["content-disposition"] = options.contentDisposition;
		}
		const res = await this.#fetch(url, {
			method: "POST",
			headers,
			body: body as BodyInit,
		});
		if (!res.ok) {
			throw new Error(`GCS PUT failed (${res.status}): ${await res.text()}`);
		}
		// GCS has no ACL in the media-upload call; apply visibility after.
		if (options?.visibility !== undefined) {
			await this.setVisibility(filePath, options.visibility);
		}
	}

	async getBytes(filePath: string): Promise<Uint8Array> {
		const buf = await this.get(filePath);
		if (buf === null) {
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`GCS object does not exist at path '${filePath}'`,
				{
					hint: "Confirm the bucket + key and that the object was put() first.",
				},
			);
		}
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	async putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		options?: PutStreamOptions,
	): Promise<void> {
		const name = gcsEncodeObjectName(filePath);
		const mime =
			options?.contentType ??
			(inferMimeType(extFromPath(filePath)) || "application/octet-stream");
		const declared = options?.contentLength;
		// A declared length that fits in one chunk: one media upload.
		if (declared !== undefined && declared <= GCS_RESUMABLE_CHUNK) {
			const url = `${GCS_UPLOAD_ROOT}/b/${this.#config.bucket}/o?uploadType=media&name=${name}`;
			const buf = await collectToBuffer(readable, declared);
			const token = await this.#getAccessToken();
			const res = await this.#fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": mime,
				},
				body: requestBody(buf),
			});
			if (!res.ok) {
				throw new Error(`GCS PUT failed (${res.status}): ${await res.text()}`);
			}
			return;
		}
		// Anything else goes through a resumable session, one bounded chunk at
		// a time. Collecting the stream first made a 4 GB temp file a 4 GB
		// allocation before a byte left — and copyFromFs/moveFromFs never
		// declare a length.
		const session = await this.#openResumableSession(name, mime);
		const chunks = chunkStream(readable, GCS_RESUMABLE_CHUNK)[
			Symbol.asyncIterator
		]();
		let offset = 0;
		try {
			// One chunk of look-ahead: the request that carries the last chunk
			// must say it is the last, with the total.
			let current = await chunks.next();
			for (;;) {
				const following = current.done ? current : await chunks.next();
				const chunk = current.done ? Buffer.alloc(0) : current.value;
				const last = following.done === true;
				await this.#uploadChunk(session, chunk, offset, last);
				offset += chunk.length;
				if (last) return;
				current = following;
			}
		} catch (err) {
			// Best-effort: release the session's staged bytes. The original
			// error is the one that explains the failure.
			await this.#fetch(session, { method: "DELETE" }).catch(() => {});
			throw err;
		}
	}

	/**
	 * Start a resumable upload and return its session URI.
	 *
	 * The URI comes from the provider's `Location` header and receives the
	 * object's bytes, so one that does not point at the provider's upload
	 * endpoint is refused rather than followed.
	 */
	async #openResumableSession(name: string, mime: string): Promise<string> {
		const url = `${GCS_UPLOAD_ROOT}/b/${this.#config.bucket}/o?uploadType=resumable&name=${name}`;
		const token = await this.#getAccessToken();
		const res = await this.#fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json; charset=UTF-8",
				"x-upload-content-type": mime,
			},
			body: "{}",
		});
		if (!res.ok) {
			throw new Error(
				`GCS resumable upload could not start (${res.status}): ${await res.text()}`,
			);
		}
		const session = res.headers.get("location");
		if (session === null || !session.startsWith(`${GCS_UPLOAD_ROOT}/`)) {
			throw new ArchiveError(
				"E_ARCHIVE_UNEXPECTED_RESPONSE",
				`GCS answered a resumable upload with an unusable session URI (${JSON.stringify(session)}).`,
				{
					hint: "The upload was not sent anywhere. Retry, or check for a proxy rewriting responses.",
				},
			);
		}
		return session;
	}

	/**
	 * Send one chunk of a resumable upload. A chunk that is not the last is
	 * a multiple of 256 KiB (see {@link GCS_RESUMABLE_CHUNK}) and must be
	 * persisted whole before the next is sent.
	 */
	async #uploadChunk(
		session: string,
		chunk: Buffer,
		offset: number,
		last: boolean,
	): Promise<void> {
		const end = offset + chunk.length - 1;
		const total = offset + chunk.length;
		const range = last
			? chunk.length === 0
				? `bytes */${total}`
				: `bytes ${offset}-${end}/${total}`
			: `bytes ${offset}-${end}/*`;
		const res = await this.#fetch(session, {
			method: "PUT",
			headers: { "content-range": range },
			body: requestBody(chunk),
		});
		if (last) {
			if (!res.ok) {
				throw new Error(
					`GCS resumable upload failed to finish (${res.status}): ${await res.text()}`,
				);
			}
			return;
		}
		// 308 Resume Incomplete, reporting what the provider has kept.
		const kept = res.headers.get("range");
		if (res.status !== 308 || kept !== `bytes=0-${end}`) {
			throw new Error(
				`GCS resumable upload: chunk at ${offset} not persisted (${res.status}, range ${JSON.stringify(kept)}).`,
			);
		}
	}

	async get(filePath: string): Promise<Buffer | null> {
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeObjectName(filePath)}?alt=media`;
		const token = await this.#getAccessToken();
		const res = await this.#fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GCS GET failed (${res.status})`);
		return Buffer.from(await res.arrayBuffer());
	}

	async getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeObjectName(filePath)}?alt=media`;
		const token = await this.#getAccessToken();
		const res = await this.#fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) {
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`GCS object does not exist at path '${filePath}'`,
				{
					hint: "Confirm the bucket + key and that the object was put() first.",
				},
			);
		}
		if (!res.ok) throw new Error(`GCS GET failed (${res.status})`);
		if (res.body === null) return Readable.from(Buffer.alloc(0));
		return Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>);
	}

	async delete(filePath: string): Promise<boolean> {
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeObjectName(filePath)}`;
		const token = await this.#getAccessToken();
		const res = await this.#fetch(url, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) return false;
		return res.ok || res.status === 204;
	}

	async exists(filePath: string): Promise<boolean> {
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeObjectName(filePath)}`;
		const token = await this.#getAccessToken();
		const res = await this.#fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) return false;
		// Don't swallow 403/5xx as "not found" — would hide access and
		// availability errors. Throw so the caller can distinguish.
		if (!res.ok) {
			throw new Error(`GCS EXISTS failed (${res.status})`);
		}
		return true;
	}

	publicUrl(filePath: string): string {
		if (this.#config.publicUrl) {
			const publicRoot = this.#config.publicUrl.replace(/\/+$/, "");
			return `${publicRoot}/${gcsEncodeKey(filePath)}`;
		}
		return `${GCS_API_ROOT}/${this.#config.bucket}/${gcsEncodeKey(filePath)}`;
	}

	async url(filePath: string): Promise<string> {
		const meta = await this.getMetadata(filePath);
		if (meta.visibility === "public") return this.publicUrl(filePath);
		return this.getSignedUrl(filePath);
	}

	async getMetadata(filePath: string): Promise<Metadata> {
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeObjectName(filePath)}`;
		const token = await this.#getAccessToken();
		const res = await this.#fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) {
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`GCS object does not exist at path '${filePath}'`,
				{ hint: "Confirm the bucket + key." },
			);
		}
		if (!res.ok) {
			throw new Error(`GCS HEAD failed (${res.status}): ${await res.text()}`);
		}
		const json = (await res.json()) as {
			size?: string;
			contentType?: string;
			updated?: string;
			etag?: string;
			acl?: Array<{ entity?: string; role?: string }>;
		};
		const visibility: Visibility = Array.isArray(json.acl)
			? json.acl.some(
					(a) =>
						a.entity === "allUsers" &&
						(a.role === "READER" || a.role === "OWNER"),
				)
				? "public"
				: "private"
			: "private";
		const size = Number.parseInt(json.size ?? "0", 10);
		const mimeType = json.contentType ?? "application/octet-stream";
		return {
			size,
			contentLength: size,
			mimeType,
			contentType: mimeType,
			lastModified: json.updated ? new Date(json.updated) : new Date(0),
			etag: (json.etag ?? "").replace(/^(W\/)?"(.*)"$/, "$1$2"),
			visibility,
		};
	}

	async getVisibility(filePath: string): Promise<Visibility> {
		return (await this.getMetadata(filePath)).visibility;
	}

	async setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		const base = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeObjectName(filePath)}/acl`;
		const token = await this.#getAccessToken();
		if (visibility === "public") {
			const res = await this.#fetch(base, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ entity: "allUsers", role: "READER" }),
			});
			if (!res.ok) {
				throw new Error(
					`GCS setVisibility public failed (${res.status}): ${await res.text()}`,
				);
			}
		} else {
			const res = await this.#fetch(`${base}/allUsers`, {
				method: "DELETE",
				headers: { authorization: `Bearer ${token}` },
			});
			// 404 = already private (no allUsers ACL) — idempotent success.
			if (!res.ok && res.status !== 404) {
				throw new Error(
					`GCS setVisibility private failed (${res.status}): ${await res.text()}`,
				);
			}
		}
	}

	async copy(from: string, to: string, options?: WriteOptions): Promise<void> {
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeObjectName(from)}/copyTo/b/${this.#config.bucket}/o/${gcsEncodeObjectName(to)}`;
		const token = await this.#getAccessToken();
		const res = await this.#fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) {
			throw new ArchiveError(
				"E_ARCHIVE_NOT_FOUND",
				`GCS copy source does not exist at path '${from}'`,
				{ hint: "Confirm the source object was put() first." },
			);
		}
		if (!res.ok) {
			throw new Error(`GCS COPY failed (${res.status}): ${await res.text()}`);
		}
		if (options?.visibility !== undefined) {
			await this.setVisibility(to, options.visibility);
		}
	}

	async move(from: string, to: string, options?: WriteOptions): Promise<void> {
		// Non-atomic: copy then delete. Same as S3.
		await this.copy(from, to, options);
		await this.delete(from);
	}

	async deleteAll(given: string): Promise<void> {
		const prefix = normalizePrefix(given);
		// GCS has no batch-delete endpoint; drain the listing one object at
		// a time. `list()` already paginates lazily.
		const keys: string[] = [];
		for await (const entry of this.list(prefix)) {
			keys.push(entry.path);
		}
		for (const key of keys) {
			await this.delete(key);
		}
	}

	async listAll(
		given: string,
		options?: ListAllOptions,
	): Promise<ListAllResult> {
		const recursive = options?.recursive ?? false;
		const prefix = normalizePrefix(given);
		const normalizedPrefix =
			prefix === ""
				? ""
				: !recursive && !prefix.endsWith("/")
					? `${prefix}/`
					: prefix;
		const params = new URLSearchParams({ prefix: normalizedPrefix });
		if (!recursive) params.set("delimiter", "/");
		if (options?.paginationToken) {
			params.set("pageToken", options.paginationToken);
		}
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o?${params.toString()}`;
		const token = await this.#getAccessToken();
		const res = await this.#fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
		});
		if (!res.ok) {
			throw new Error(`GCS LIST failed (${res.status}): ${await res.text()}`);
		}
		const json = (await res.json()) as {
			items?: Array<{
				name?: string;
				size?: string;
				updated?: string;
				contentType?: string;
				etag?: string;
			}>;
			prefixes?: string[];
			nextPageToken?: string;
		};
		const objects: Array<DriveFile | DriveDirectory> = [];
		for (const dir of json.prefixes ?? []) {
			objects.push(new DriveDirectory(dir.replace(/\/$/, "")));
		}
		for (const item of json.items ?? []) {
			const size = Number.parseInt(item.size ?? "0", 10);
			const mimeType = item.contentType ?? "application/octet-stream";
			objects.push(
				new DriveFile(item.name ?? "", this, {
					size,
					contentLength: size,
					mimeType,
					contentType: mimeType,
					lastModified: item.updated ? new Date(item.updated) : new Date(0),
					etag: (item.etag ?? "").replace(/^(W\/)?"(.*)"$/, "$1$2"),
					visibility: "private",
				}),
			);
		}
		return { paginationToken: json.nextPageToken, objects };
	}

	async *list(given: string): AsyncIterable<StorageEntry> {
		const prefix = normalizePrefix(given);
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({ prefix });
			if (pageToken) params.set("pageToken", pageToken);
			const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o?${params.toString()}`;
			const token = await this.#getAccessToken();
			const res = await this.#fetch(url, {
				method: "GET",
				headers: { authorization: `Bearer ${token}` },
			});
			if (!res.ok) {
				throw new Error(`GCS LIST failed (${res.status}): ${await res.text()}`);
			}
			const json = (await res.json()) as {
				items?: Array<{ name?: string; size?: string; updated?: string }>;
				nextPageToken?: string;
			};
			for (const item of json.items ?? []) {
				yield {
					path: item.name ?? "",
					size: Number.parseInt(item.size ?? "0", 10),
					lastModified: item.updated ? new Date(item.updated) : new Date(0),
				};
			}
			pageToken = json.nextPageToken;
		} while (pageToken);
	}

	getSignedUrl(filePath: string, options?: SignedUrlOptions): string {
		const responseParams: Array<[string, string]> = [];
		if (options?.contentType) {
			responseParams.push(["response-content-type", options.contentType]);
		}
		if (options?.contentDisposition) {
			responseParams.push([
				"response-content-disposition",
				options.contentDisposition,
			]);
		}
		return this.#presign("GET", filePath, options, responseParams);
	}

	/**
	 * Presigned PUT URL for direct-to-GCS uploads. AdonisJS Drive parity.
	 * Signed headers are `host` only, so the uploading client is free to
	 * set its own `Content-Type`.
	 */
	getSignedUploadUrl(filePath: string, options?: SignedUrlOptions): string {
		return this.#presign("PUT", filePath, options, []);
	}

	/**
	 * Shared GOOG4-RSA-SHA256 query-parameter presigner for GET (read)
	 * and PUT (upload) URLs. Signs `host` only; extra query params (e.g.
	 * `response-content-*`) participate in the signature.
	 */
	#presign(
		method: "GET" | "PUT",
		filePath: string,
		options: SignedUrlOptions | undefined,
		extraQueryParams: Array<[string, string]>,
	): string {
		const expiresIn = parseExpiry(options?.expiresIn ?? DEFAULT_EXPIRES_IN);
		assertValidExpiry(expiresIn);
		const dateStamp = amzDateNow();
		const shortDate = dateStamp.slice(0, 8);
		const scope = `${shortDate}/auto/storage/goog4_request`;
		const credential = `${this.#config.serviceAccount.client_email}/${scope}`;

		const queryParams: Array<[string, string]> = [
			["X-Goog-Algorithm", "GOOG4-RSA-SHA256"],
			["X-Goog-Credential", credential],
			["X-Goog-Date", dateStamp],
			["X-Goog-Expires", String(expiresIn)],
			["X-Goog-SignedHeaders", "host"],
			...extraQueryParams,
		];
		const canonicalQs = queryParams
			.slice()
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([k, v]) => `${gcsStrictEncode(k)}=${gcsStrictEncode(v)}`)
			.join("&");

		const canonicalRequest = [
			method,
			`/${this.#config.bucket}/${gcsEncodeKey(filePath)}`,
			canonicalQs,
			"host:storage.googleapis.com\n",
			"host",
			"UNSIGNED-PAYLOAD",
		].join("\n");

		const stringToSign = [
			"GOOG4-RSA-SHA256",
			dateStamp,
			scope,
			createHash("sha256").update(canonicalRequest).digest("hex"),
		].join("\n");

		const signer = createSign("RSA-SHA256");
		signer.update(stringToSign);
		const signature = signer
			.sign(this.#config.serviceAccount.private_key)
			.toString("hex");

		return `${GCS_API_ROOT}/${this.#config.bucket}/${gcsEncodeKey(filePath)}?${canonicalQs}&X-Goog-Signature=${signature}`;
	}

	/** Fetch or refresh the OAuth access token. Lock-free: concurrent
	 *  callers may trigger parallel refreshes; last-writer-wins is
	 *  acceptable because token exchange is idempotent. */
	async #getAccessToken(): Promise<string> {
		const now = Date.now();
		if (
			this.#cachedToken &&
			// Refresh when < 5 min remain before expiry.
			this.#cachedToken.expiresAt - now > 5 * 60 * 1000
		) {
			return this.#cachedToken.value;
		}
		const iat = Math.floor(now / 1000);
		const exp = iat + 3600;
		const header = base64url(
			Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })),
		);
		const claim = base64url(
			Buffer.from(
				JSON.stringify({
					iss: this.#config.serviceAccount.client_email,
					scope: GCS_SCOPE,
					aud: GCS_OAUTH_URL,
					exp,
					iat,
				}),
			),
		);
		const unsigned = `${header}.${claim}`;
		const signer = createSign("RSA-SHA256");
		signer.update(unsigned);
		const sig = base64url(signer.sign(this.#config.serviceAccount.private_key));
		const jwt = `${unsigned}.${sig}`;

		const body = new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: jwt,
		}).toString();
		const res = await this.#fetch(GCS_OAUTH_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		if (!res.ok) {
			throw new Error(
				`GCS token exchange failed (${res.status}): ${await res.text()}`,
			);
		}
		const json = (await res.json()) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!json.access_token) {
			throw new Error("GCS token exchange: access_token missing from response");
		}
		this.#cachedToken = {
			value: json.access_token,
			expiresAt: now + (json.expires_in ?? 3600) * 1000,
		};
		return json.access_token;
	}
}

/** Returns the current instant in basic-ISO8601 form: `YYYYMMDDTHHMMSSZ`. */
function amzDateNow(): string {
	return `${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

/** Extract the lowercase file extension from a path (including the dot). */
function extFromPath(filePath: string): string {
	const idx = filePath.lastIndexOf(".");
	if (idx < 0) return "";
	return filePath.slice(idx).toLowerCase();
}
