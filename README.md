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

## Serving local files

A local disk builds its URLs under its `routeBasePath` (default `/storage`).
Mount the signed route on that path: it reads the prefix from the driver,
serves public files, refuses private ones unless the URL carries a valid
signature (from `getSignedUrl`), and streams the file with an ETag so a
client revalidating its copy gets a 304.

```ts
import { createSignedRouteHandler } from '@c9up/archive/signed-route'

const handler = createSignedRouteHandler({ storage, driver })
```

## Entry points

- `@c9up/archive` — main API
- `@c9up/archive/provider` — Ream IoC provider
- `@c9up/archive/services/main` — container service accessor
- `@c9up/archive/signed-route` — signed-URL route helper
- `@c9up/archive/testing` — test fakes & helpers

## License

MIT
