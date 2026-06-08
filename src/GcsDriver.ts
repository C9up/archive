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
import { assertValidExpiry, DEFAULT_EXPIRES_IN } from "./expiry.js";
import { inferMimeType } from "./mime-types.js";
import type {
	Metadata,
	PutStreamOptions,
	SignedUrlOptions,
	StorageDriver,
	StorageEntry,
	Visibility,
} from "./StorageManager.js";

/** GCS V4 strict URL encoding — identical to AWS's RFC3986-unreserved
 *  set. Duplicated from `S3Driver.ts` on purpose: per cerebrum rule,
 *  drivers do not share helpers even within the package. */
function gcsStrictEncode(str: string): string {
	return encodeURIComponent(str).replace(
		/[!*'()]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** Encode an object path segment-by-segment, preserving `/`. */
function gcsEncodeKey(key: string): string {
	return key.split("/").map(gcsStrictEncode).join("/");
}

/** Type guard matching the same pattern as `S3Driver.hasDestroy` —
 *  duplicated on purpose (package-local). */
function hasDestroy(x: unknown): x is { destroy(err?: Error): void } {
	return (
		typeof x === "object" &&
		x !== null &&
		typeof (x as { destroy?: unknown }).destroy === "function"
	);
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
}

const GCS_API_ROOT = "https://storage.googleapis.com";
const GCS_UPLOAD_ROOT = "https://storage.googleapis.com/upload/storage/v1";
const GCS_META_ROOT = "https://storage.googleapis.com/storage/v1";
const GCS_OAUTH_URL = "https://oauth2.googleapis.com/token";
const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

export class GcsDriver implements StorageDriver {
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

	async put(filePath: string, content: Buffer | string): Promise<void> {
		const body = typeof content === "string" ? Buffer.from(content) : content;
		const token = await this.#getAccessToken();
		const url = `${GCS_UPLOAD_ROOT}/b/${this.#config.bucket}/o?uploadType=media&name=${gcsStrictEncode(filePath)}`;
		const mime =
			inferMimeType(extFromPath(filePath)) || "application/octet-stream";
		const res = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": mime,
			},
			body: body as BodyInit,
		});
		if (!res.ok) {
			throw new Error(`GCS PUT failed (${res.status}): ${await res.text()}`);
		}
	}

	async putStream(
		filePath: string,
		readable: NodeJS.ReadableStream,
		options?: PutStreamOptions,
	): Promise<void> {
		// Single-PUT path only for this story. Resumable upload parity is
		// deferred — document upgrade path here when a real large-file
		// case appears.
		const maxBytes = options?.contentLength ?? Number.MAX_SAFE_INTEGER;
		const buf = await collectToBuffer(readable, maxBytes);
		const token = await this.#getAccessToken();
		const url = `${GCS_UPLOAD_ROOT}/b/${this.#config.bucket}/o?uploadType=media&name=${gcsStrictEncode(filePath)}`;
		const mime =
			options?.contentType ??
			(inferMimeType(extFromPath(filePath)) || "application/octet-stream");
		const res = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": mime,
			},
			body: buf as BodyInit,
		});
		if (!res.ok) {
			throw new Error(`GCS PUT failed (${res.status}): ${await res.text()}`);
		}
	}

	async get(filePath: string): Promise<Buffer | null> {
		const token = await this.#getAccessToken();
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeKey(filePath)}?alt=media`;
		const res = await fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GCS GET failed (${res.status})`);
		return Buffer.from(await res.arrayBuffer());
	}

	async getStream(filePath: string): Promise<NodeJS.ReadableStream> {
		const token = await this.#getAccessToken();
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeKey(filePath)}?alt=media`;
		const res = await fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
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
		const token = await this.#getAccessToken();
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeKey(filePath)}`;
		const res = await fetch(url, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) return false;
		return res.ok || res.status === 204;
	}

	async exists(filePath: string): Promise<boolean> {
		const token = await this.#getAccessToken();
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeKey(filePath)}`;
		const res = await fetch(url, {
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
		const token = await this.#getAccessToken();
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeKey(filePath)}`;
		const res = await fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
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
		return {
			size: Number.parseInt(json.size ?? "0", 10),
			mimeType: json.contentType ?? "application/octet-stream",
			lastModified: json.updated ? new Date(json.updated) : new Date(0),
			etag: (json.etag ?? "").replace(/^(W\/)?"(.*)"$/, "$1$2"),
			visibility,
		};
	}

	async setVisibility(filePath: string, visibility: Visibility): Promise<void> {
		const token = await this.#getAccessToken();
		const base = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeKey(filePath)}/acl`;
		if (visibility === "public") {
			const res = await fetch(base, {
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
			const res = await fetch(`${base}/allUsers`, {
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

	async copy(from: string, to: string): Promise<void> {
		const token = await this.#getAccessToken();
		const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o/${gcsEncodeKey(from)}/copyTo/b/${this.#config.bucket}/o/${gcsEncodeKey(to)}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		});
		if (res.status === 404) {
			throw new ArchiveError(
				"ARCHIVE_NOT_FOUND",
				`GCS copy source does not exist at path '${from}'`,
				{ hint: "Confirm the source object was put() first." },
			);
		}
		if (!res.ok) {
			throw new Error(`GCS COPY failed (${res.status}): ${await res.text()}`);
		}
	}

	async move(from: string, to: string): Promise<void> {
		// Non-atomic: copy then delete. Same as S3.
		await this.copy(from, to);
		await this.delete(from);
	}

	async *list(prefix: string): AsyncIterable<StorageEntry> {
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({ prefix });
			if (pageToken) params.set("pageToken", pageToken);
			const url = `${GCS_META_ROOT}/b/${this.#config.bucket}/o?${params.toString()}`;
			const token = await this.#getAccessToken();
			const res = await fetch(url, {
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
		const expiresIn = options?.expiresIn ?? DEFAULT_EXPIRES_IN;
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
		];
		const canonicalQs = queryParams
			.slice()
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([k, v]) => `${k}=${gcsStrictEncode(v)}`)
			.join("&");

		const canonicalRequest = [
			"GET",
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
		const res = await fetch(GCS_OAUTH_URL, {
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

/** Drain a readable into a Buffer, capped at `maxBytes`. Destroys the
 *  upstream on over-limit so FDs/sockets don't leak. Duplicated from
 *  `S3Driver.ts` per package-agnostic discipline. */
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
			if (hasDestroy(readable)) readable.destroy();
			throw new Error(
				`putStream: readable exceeded declared contentLength (${total} > ${maxBytes})`,
			);
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks, total);
}
