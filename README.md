# @c9up/archive

> File storage abstraction for the Ream framework — Local + S3-compatible drivers, signed URLs, expiry.

Part of **[Ream](https://github.com/C9up/ream)** — a Rust-powered, AdonisJS-compatible Node.js framework. Independent, publishable package.

## Installation

```bash
pnpm add @c9up/archive
ream configure @c9up/archive
```

## Usage

Register the provider in your app, then configure it under `config/archive.ts`:

```ts
// reamrc.ts
providers: [
  () => import('@c9up/archive/provider'),
]
```

## Entry points

- `@c9up/archive` — main API
- `@c9up/archive/provider` — Ream IoC provider
- `@c9up/archive/services/main` — container service accessor
- `@c9up/archive/signed-route` — signed-URL route helper
- `@c9up/archive/testing` — test fakes & helpers

## License

MIT
