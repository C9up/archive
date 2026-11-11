# @c9up/archive

> File storage abstraction for the Ream framework — local, S3-compatible and GCS drivers, signed URLs, expiry.

Part of **[Ream](https://github.com/C9up/ream)** — a Rust-powered Node.js framework. Independent, publishable package.

## Installation

```bash
pnpm add @c9up/archive
ream configure @c9up/archive
```

`ream add @c9up/archive` installs it, registers the provider and writes
`config/archive.ts`. The rest of this page assumes that has run.

## Usage

Register the provider in your app, then configure it under `config/archive.ts`:

```ts
// reamrc.ts
providers: [
  () => import('@c9up/archive/provider'),
]
```

## Visibility and signed URLs

Every stored object is `public` or `private`. Pass `visibility` when writing,
or change it afterwards:

```ts
await disk.put('invoices/42.pdf', bytes, { visibility: 'private' })
await disk.setVisibility('avatars/1.png', 'public')
const visibility = await disk.getVisibility('invoices/42.pdf') // 'private'
```

On the local disk a file with no visibility marker is `public`; a file made
private carries a marker beside it. On S3 the visibility is the object's ACL
(`public-read` or `private`), and an object whose ACL cannot be read counts as
private.

`url(path)` follows the visibility: a public file gets its plain URL, a
private one a signed URL. `getSignedUrl(path, { expiresIn })` signs
explicitly; `expiresIn` is a number of seconds or a duration string (`'30m'`,
`'7 days'`), 5 minutes by default, between 1 second and 7 days:

```ts
const link = await disk.getSignedUrl('invoices/42.pdf', { expiresIn: '30m' })
```

The local disk signs with its `signingSecret` (HMAC-SHA256). Without one,
`getSignedUrl` throws `E_ARCHIVE_SIGNING_DISABLED`; the other methods still
work.

## Serving the local disk

A local disk builds its URLs under its `routeBasePath`: `/storage` unless
`services.fs({ routeBasePath })` says otherwise. Nothing serves that path until
you mount the signed route from `@c9up/archive/signed-route`. It reads the
prefix from the driver, serves public files, refuses a private file unless the
URL carries a valid signature, and streams the file with an ETag, so a client
revalidating its copy gets a 304:

```ts
// start/storage.ts
import { LocalDriver, StorageManager } from '@c9up/archive'
import { createSignedRouteHandler } from '@c9up/archive/signed-route'
import env from '#start/env'

export const driver = new LocalDriver('storage/uploads', {
  signingSecret: env.get('APP_KEY'),
})
export const uploads = new StorageManager(driver)
export const serveUploads = createSignedRouteHandler({ storage: uploads, driver })
```

```ts
// start/kernel.ts
import { serveUploads } from '#start/storage'

server.use([serveUploads])
```

`createSignedRouteHandler` throws at construction when the driver has no
`signingSecret`, and throws `E_ARCHIVE_PREFIX_MISMATCH` when a `prefix` option
disagrees with the driver's `routeBasePath`: configure the path on the driver
and leave `prefix` out. A refused request gets a JSON body
`{ error: { code, message } }`:

| Status | Code | When |
| --- | --- | --- |
| 403 | `E_ARCHIVE_INVALID_SIGNATURE` | The signature, its expiry or a signed header override is malformed or does not match |
| 403 | `E_ARCHIVE_EXPIRED_SIGNATURE` | The signature is valid but its `exp` has passed |
| 403 | `E_ARCHIVE_ACCESS_DENIED` | An unsigned request for a private file |
| 403 | `E_ARCHIVE_INVALID_KEY` | The path names no key the disk will address |
| 404 | `E_ARCHIVE_NOT_FOUND` | A valid signature for a file that is not stored |

An unsigned request for a name that is not stored falls through to the next
middleware.

## Static files

`StaticMiddleware` serves a directory of assets (`root`), under `prefix`
(default `/static`), with `max-age` set by `maxAge` (default 0: the browser
keeps the bytes and revalidates them through the ETag):

```ts
import { StaticMiddleware } from '@c9up/archive'

const assets = new StaticMiddleware({ root: 'public', prefix: '/assets' })
server.use([assets.handle.bind(assets)])
```

Point it at public assets only, never at a local disk's directory. It has no
signature check: it refuses a file whose visibility marker says private and
never serves the markers themselves, but everything else under `root` is
served to anyone who asks. Private files are served through the signed route.

## Entry points

- `@c9up/archive` — main API
- `@c9up/archive/provider` — Ream IoC provider
- `@c9up/archive/services/main` — container service accessor
- `@c9up/archive/signed-route` — the route that serves a local disk (see above)
- `@c9up/archive/testing` — test fakes & helpers

## License

MIT
