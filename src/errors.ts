/**
 * Archive errors, one per code (agnostic; no @c9up/ream dependency).
 *
 * What the storage library raises, archive raises with the same code and
 * message: the key normaliser's refusals (`E_UNALLOWED_CHARACTERS`,
 * `E_PATH_TRAVERSAL_DETECTED`, `E_INVALID_KEY`), and the `E_CANNOT_*` error
 * each disk operation wraps a driver failure in, the driver's own error as
 * `cause`. Everything archive adds carries the `E_ARCHIVE_` namespace.
 */
import { createError, Exception } from "@c9up/flare";

/**
 * A key carrying a control character, a backslash or an encoded separator.
 * Which one is in the instance's `help`.
 */
export const E_UNALLOWED_CHARACTERS = createError<[string]>(
	'The key "%s" has unallowed characters',
	"E_UNALLOWED_CHARACTERS",
);
E_UNALLOWED_CHARACTERS.help =
	"Use '/' as the only separator, and no control characters.";

/** A key with a dot-only segment such as `..`. */
export const E_PATH_TRAVERSAL_DETECTED = createError<[string]>(
	'Path traversal segment detected in key "%s"',
	"E_PATH_TRAVERSAL_DETECTED",
);
E_PATH_TRAVERSAL_DETECTED.help =
	"Keys are relative to the disk: build them without '..' segments.";

/** A key that normalises to nothing. */
export const E_INVALID_KEY = createError<[string]>(
	'Invalid key "%s". After normalization results in an empty string',
	"E_INVALID_KEY",
);
E_INVALID_KEY.help =
	"Name the object: a key cannot be empty or only separators.";

/** A disk could not write the file; the driver's error is the `cause`. */
export const E_CANNOT_WRITE_FILE = createError<[string]>(
	'Cannot write file at location "%s"',
	"E_CANNOT_WRITE_FILE",
);

/** A disk could not read the file; the driver's error is the `cause`. */
export const E_CANNOT_READ_FILE = createError<[string]>(
	'Cannot read file from location "%s"',
	"E_CANNOT_READ_FILE",
);

/** A disk could not delete the file; the driver's error is the `cause`. */
export const E_CANNOT_DELETE_FILE = createError<[string]>(
	'Cannot delete file at location "%s"',
	"E_CANNOT_DELETE_FILE",
);

/** A disk could not delete under a prefix; the driver's error is the `cause`. */
export const E_CANNOT_DELETE_DIRECTORY = createError<[string]>(
	'Cannot delete directory at location "%s"',
	"E_CANNOT_DELETE_DIRECTORY",
);

/** A disk could not copy the file; the driver's error is the `cause`. */
export const E_CANNOT_COPY_FILE = createError<[string, string]>(
	'Cannot copy file from "%s" to "%s"',
	"E_CANNOT_COPY_FILE",
);

/** A disk could not move the file; the driver's error is the `cause`. */
export const E_CANNOT_MOVE_FILE = createError<[string, string]>(
	'Cannot move file from "%s" to "%s"',
	"E_CANNOT_MOVE_FILE",
);

/** A disk could not tell whether the file exists; the driver's error is the `cause`. */
export const E_CANNOT_CHECK_FILE_EXISTENCE = createError<[string]>(
	'Unable to check existence for file at location "%s"',
	"E_CANNOT_CHECK_FILE_EXISTENCE",
);

/**
 * A disk could not read the file's metadata or visibility; the driver's error
 * is the `cause`.
 */
export const E_CANNOT_GET_METADATA = createError<[string]>(
	'Unable to retrieve metadata of file at location "%s"',
	"E_CANNOT_GET_METADATA",
);

/** A disk could not set the file's visibility; the driver's error is the `cause`. */
export const E_CANNOT_SET_VISIBILITY = createError<[string]>(
	'Unable to set visibility for file at location "%s"',
	"E_CANNOT_SET_VISIBILITY",
);

/** A disk could not build a URL for the file; the driver's error is the `cause`. */
export const E_CANNOT_GENERATE_URL = createError<[string]>(
	'Cannot generate URL for file at location "%s"',
	"E_CANNOT_GENERATE_URL",
);

/**
 * The signed-URL route could not serve a stored file, for a reason other than
 * the file being absent (that one answers 404); the failure is the `cause`.
 * Built as the library builds it: `new E_CANNOT_SERVE_FILE(originalError)`.
 */
export const E_CANNOT_SERVE_FILE = class CannotServeFileException extends Exception {
	static override code = "E_CANNOT_SERVE_FILE";
	static override status = 500;

	constructor(originalError: unknown) {
		super("Cannot serve local file using drive", {
			code: "E_CANNOT_SERVE_FILE",
			status: 500,
			cause: originalError,
		});
	}
};
export type E_CANNOT_SERVE_FILE = InstanceType<typeof E_CANNOT_SERVE_FILE>;

/** A key archive reserves, or a key that is not a string. */
export const E_ARCHIVE_INVALID_KEY = createError<[string]>(
	"%s",
	"E_ARCHIVE_INVALID_KEY",
);

/** A local path that resolves outside the disk root, lexically or through a link. */
export const E_ARCHIVE_PATH_TRAVERSAL_DETECTED = createError<[string]>(
	"%s",
	"E_ARCHIVE_PATH_TRAVERSAL_DETECTED",
);

/**
 * The object does not exist. A driver raises it; a disk operation hands it on
 * as the `cause` of its `E_CANNOT_*` error.
 */
export const E_ARCHIVE_NOT_FOUND = createError<[string]>(
	"%s",
	"E_ARCHIVE_NOT_FOUND",
	404,
);

/**
 * The storage provider (S3, GCS) refused a request or reported a failure.
 * `providerStatus` is the HTTP status the provider answered with: it is the
 * provider's status, not one to answer the app's own client with, which is
 * why it is not `status` (that one stays 500).
 */
export class E_ARCHIVE_REMOTE_FAILED extends Exception {
	static override code = "E_ARCHIVE_REMOTE_FAILED";

	/** The HTTP status the storage provider answered with. */
	readonly providerStatus: number;

	constructor(providerStatus: number, message: string, options?: ErrorOptions) {
		super(message, options);
		this.providerStatus = providerStatus;
	}
}

/** The storage provider answered something archive cannot read. */
export const E_ARCHIVE_UNEXPECTED_RESPONSE = createError<[string]>(
	"%s",
	"E_ARCHIVE_UNEXPECTED_RESPONSE",
);

/** The storage provider stopped answering for longer than the idle timeout. */
export const E_ARCHIVE_REQUEST_TIMEOUT = createError<[number]>(
	"The storage provider did not answer within %dms.",
	"E_ARCHIVE_REQUEST_TIMEOUT",
);
E_ARCHIVE_REQUEST_TIMEOUT.help =
	"The bound is an idle timeout: raise `requestTimeoutMs` for a slow link, or check connectivity to the bucket.";

/** A stream longer than the `contentLength` it declared. */
export const E_ARCHIVE_CONTENT_LENGTH_EXCEEDED = createError<[number, number]>(
	"putStream: readable exceeded declared contentLength (%d > %d)",
	"E_ARCHIVE_CONTENT_LENGTH_EXCEEDED",
);

/** `config.driver` names a driver whose own config block is missing. */
export const E_ARCHIVE_CONFIG_MISSING = createError<[string]>(
	"%s",
	"E_ARCHIVE_CONFIG_MISSING",
);

/** `config.driver` is not a driver archive knows. */
export const E_ARCHIVE_INVALID_DRIVER = createError<[string]>(
	"Archive config.driver must be 'local', 's3', or 'gcs', got '%s'",
	"E_ARCHIVE_INVALID_DRIVER",
);
E_ARCHIVE_INVALID_DRIVER.help =
	"Set config.archive.driver to 'local', 's3', or 'gcs'.";

/** A driver built without the options it needs. */
export const E_ARCHIVE_INVALID_DRIVER_CONFIG = createError<[string]>(
	"%s",
	"E_ARCHIVE_INVALID_DRIVER_CONFIG",
);

/** A disk name `config.services` does not declare. */
export const E_ARCHIVE_UNKNOWN_DISK = createError<[string]>(
	"%s",
	"E_ARCHIVE_UNKNOWN_DISK",
);

/** A signed-URL lifetime that is not a positive duration of at most 7 days. */
export const E_ARCHIVE_INVALID_EXPIRY = createError<[string]>(
	"%s",
	"E_ARCHIVE_INVALID_EXPIRY",
);

/** A response-header override carrying a control character. */
export const E_ARCHIVE_INVALID_HEADER_VALUE = createError<[string, string]>(
	"%s cannot be signed as a %s value: it contains a control character",
	"E_ARCHIVE_INVALID_HEADER_VALUE",
);
E_ARCHIVE_INVALID_HEADER_VALUE.help =
	"Header values cannot carry CR, LF, NUL or other controls.";

/** A local-disk signing secret that is missing or too short. */
export const E_ARCHIVE_WEAK_SIGNING_SECRET = createError<[string]>(
	"LocalDriver signingSecret must be a string or a Secret wrapping one, at least 16 chars (got %s)",
	"E_ARCHIVE_WEAK_SIGNING_SECRET",
);
E_ARCHIVE_WEAK_SIGNING_SECRET.help =
	"Use a cryptographically random secret, e.g. `crypto.randomBytes(32).toString('hex')`.";

/** A signed URL asked of a local disk that has no signing secret. */
export const E_ARCHIVE_SIGNING_DISABLED = createError<[string]>(
	"%s",
	"E_ARCHIVE_SIGNING_DISABLED",
);

/** A presigned upload URL asked of the local disk. */
export const E_ARCHIVE_SIGNED_UPLOAD_UNSUPPORTED = createError(
	"LocalDriver does not support presigned upload URLs",
	"E_ARCHIVE_SIGNED_UPLOAD_UNSUPPORTED",
);
E_ARCHIVE_SIGNED_UPLOAD_UNSUPPORTED.help =
	"Presigned uploads are an S3/GCS feature. For local storage, upload through your app's HTTP handler.";

/** A local-disk `routeBasePath` that is not an absolute URL path. */
export const E_ARCHIVE_INVALID_ROUTE_BASE_PATH = createError<[string]>(
	"LocalDriver routeBasePath must be an absolute URL path such as '/storage', got %s",
	"E_ARCHIVE_INVALID_ROUTE_BASE_PATH",
);
E_ARCHIVE_INVALID_ROUTE_BASE_PATH.help =
	"Start it with '/', name at least one segment, and leave out '?', '#' and whitespace.";

/** A signed-route prefix that differs from the driver's `routeBasePath`. */
export const E_ARCHIVE_PREFIX_MISMATCH = createError<[string, string]>(
	"createSignedRouteHandler: prefix '%s' does not match the driver's routeBasePath '%s', so no URL the driver signs would ever reach this route.",
	"E_ARCHIVE_PREFIX_MISMATCH",
);
E_ARCHIVE_PREFIX_MISMATCH.help =
	"Set routeBasePath on the LocalDriver (or services.fs) and leave prefix out.";

/** An empty `StaticMiddleware` prefix. */
export const E_ARCHIVE_INVALID_STATIC_PREFIX = createError(
	"StaticMiddleware: prefix cannot be empty. Use '/static' (default) or a specific path like '/assets'.",
	"E_ARCHIVE_INVALID_STATIC_PREFIX",
);

/** A visibility marker that cannot be read; archive refuses to guess. */
export const E_ARCHIVE_VISIBILITY_CORRUPT = createError<[string]>(
	"%s",
	"E_ARCHIVE_VISIBILITY_CORRUPT",
);

/** A move whose file landed but whose visibility marker could not follow. */
export const E_ARCHIVE_VISIBILITY_MOVE_FAILED = createError<
	[string, string, string]
>(
	"move('%s' -> '%s'): main file moved but visibility sidecar write failed (%s). Target visibility is undefined.",
	"E_ARCHIVE_VISIBILITY_MOVE_FAILED",
);
E_ARCHIVE_VISIBILITY_MOVE_FAILED.help =
	"Re-apply visibility via setVisibility() on the target path.";

/** `moveToDisk()` options archive cannot use. */
export const E_ARCHIVE_INVALID_MOVE_OPTIONS = createError<[string]>(
	"Invalid moveToDisk() options: %s",
	"E_ARCHIVE_INVALID_MOVE_OPTIONS",
);
E_ARCHIVE_INVALID_MOVE_OPTIONS.help =
	"moveToDisk(key, disk?, { visibility, contentType, cacheControl, contentDisposition, contentLength, moveAs }).";

/** The installed @c9up/ream has no macroable MultipartFile. */
export const E_ARCHIVE_MULTIPART_NOT_MACROABLE = createError(
	"The installed @c9up/ream has no macroable MultipartFile: uploads cannot be given moveToDisk().",
	"E_ARCHIVE_MULTIPART_NOT_MACROABLE",
);
E_ARCHIVE_MULTIPART_NOT_MACROABLE.help =
	"Upgrade @c9up/ream to a version whose MultipartFile extends Macroable.";

/** The app's template engine cannot take the drive helpers. */
export const E_ARCHIVE_TEMPLATE_ENGINE = createError(
	"The app renders with inker, but its module exposes neither use() nor global(): the drive template helpers cannot be published.",
	"E_ARCHIVE_TEMPLATE_ENGINE",
);
E_ARCHIVE_TEMPLATE_ENGINE.help =
	"Install a @c9up/inker version whose default export has use(plugin) or global(name, value).";

/** `ArchiveProvider.boot()` ran before `register()`. */
export const E_ARCHIVE_PROVIDER_NOT_REGISTERED = createError(
	"ArchiveProvider.boot() ran before register().",
	"E_ARCHIVE_PROVIDER_NOT_REGISTERED",
);
E_ARCHIVE_PROVIDER_NOT_REGISTERED.help =
	"Providers register before they boot — call register() first.";

/** The storage service used before `ArchiveProvider` booted. */
export const E_ARCHIVE_NOT_BOOTED = createError(
	"[archive] StorageManager singleton accessed before ArchiveProvider.boot() ran. Check that `@c9up/archive/provider` is listed in your reamrc.ts providers, and that an `archive` config block is set.",
	"E_ARCHIVE_NOT_BOOTED",
);

/** An invariant of archive itself broke. */
export const E_ARCHIVE_INTERNAL = createError(
	"[archive] could not build the storage accessor",
	"E_ARCHIVE_INTERNAL",
);

/** A `FakeStorage` predicate that would match every object. */
export const E_ARCHIVE_INVALID_PREDICATE = createError(
	"FakeStorage: `contentContaining` predicate cannot be an empty string — it would match every captured object.",
	"E_ARCHIVE_INVALID_PREDICATE",
);
