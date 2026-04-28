# adapter-bun

A Next.js adapter for running production builds on [Bun](https://bun.sh).

At build time, it hooks into Next.js (`modifyConfig` + `onBuildComplete`) and writes a `bun-dist/` runtime package with:

- a Bun-launched server entry (`server.js`)
- adapter runtime/cache modules (`runtime/*.js`)
- staged static assets (`static/`)
- a deployment manifest (`deployment-manifest.json`)
- a SQLite cache database (`cache.db`)

## Current status

This repo is currently marked `private` in `package.json`, so use it as a local/workspace dependency.

## Quick start

Install as a local dependency (example path):

```bash
bun add adapter-bun@file:../adapter-bun
```

Point `next.config.ts` at the adapter:

```ts
import type { NextConfig } from 'next';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const config: NextConfig = {
  adapterPath: require.resolve('adapter-bun'),
};

export default config;
```

Build and run:

```bash
bun --bun next build
bun bun-dist/server.js
```

## Important runtime note

`bun-dist/` is not a fully self-contained Next.js bundle. The runtime server still boots Next.js from your project directory and `.next` build output (by default it assumes `bun-dist/` is inside the project root). If needed, set `NEXT_PROJECT_DIR` to override the project root at runtime.

## Adapter options

To configure options, create your own adapter entry:

```ts
// bun-adapter.ts
import { createBunAdapter } from 'adapter-bun';

export default createBunAdapter({
  outDir: 'bun-dist',
  port: 3000,
  hostname: '0.0.0.0',
  deploymentHost: 'app.example.com',
  cacheHandlerMode: 'http',
  cacheEndpointPath: '/_adapter/cache',
  cacheAuthToken: 'dev-secret-token',
});
```

Then point `adapterPath` at that file:

```ts
// next.config.ts
import type { NextConfig } from 'next';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const config: NextConfig = {
  adapterPath: require.resolve('./bun-adapter.ts'),
};

export default config;
```

### Option reference

- `outDir?: string`  
  Output directory (`bun-dist` by default).
- `port?: number`  
  Default listen port written into `deployment-manifest.json`.
- `hostname?: string`  
  Default listen hostname written into `deployment-manifest.json`.
- `deploymentHost?: string`  
  Canonical deployed host used for Server Actions CSRF allow-listing.
- `cacheHandlerMode?: 'http' | 'sqlite'`  
  Cache transport for Next cache handlers. Defaults to `http`.
- `cacheEndpointPath?: string`  
  Internal cache endpoint path (HTTP mode).
- `cacheAuthToken?: string`  
  Shared secret for the internal cache endpoint (HTTP mode).
- `contextPathPlaceholder?: string | false`  
  Sentinel embedded into `basePath`/`assetPrefix` at build time. `start.js`
  replaces it with the runtime `CONTEXT_PATH` env variable before the server
  boots (see [Runtime context path](#runtime-context-path) below). Defaults to
  `/__BUN_ADAPTER_CONTEXT_PATH__`. Set to `false` to opt out entirely.

`deploymentHost` can also be set via `BUN_ADAPTER_DEPLOYMENT_HOST`.

## Runtime environment variables

- `PORT`  
  Overrides manifest port at runtime.
- `NEXT_HOSTNAME`  
  Preferred hostname for internal Next origin calculation.
- `NEXT_PROJECT_DIR`  
  Overrides inferred project root (default: parent of `bun-dist`).
- `BUN_ADAPTER_CACHE_HTTP_TOKEN`  
  Overrides cache endpoint auth token in `http` mode.
- `BUN_ADAPTER_KEEP_ALIVE_TIMEOUT`  
  Overrides Node HTTP keep-alive timeout (ms).
- `CONTEXT_PATH`  
  URL sub-path to serve under when using `start.js` (e.g. `/dashboard`). Must
  be empty or start with `/`. Trailing slashes are stripped automatically.

## Generated output

Typical `bun-dist/` contents:

```txt
bun-dist/
  server.js
  deployment-manifest.json
  runtime-next-config.json
  cache.db
  runtime/
    cache-handler.js
    cache-handler-http.js
    cache-http-client.js
    cache-http-server.js
    incremental-cache-handler.js
    incremental-cache-handler-http.js
    sqlite-cache.js
    ...
  static/
    _next/static/...
    public assets...
```

At runtime, SQLite sidecar files (`cache.db-wal`, `cache.db-shm`) are also expected.

## Feature coverage

Validated via the fixture app and deploy E2E harness:

- App Router pages and route handlers
- Pages Router pages (`getStaticProps`, `getServerSideProps`, `getStaticPaths`)
- API routes (App + Pages)
- ISR and on-demand revalidation (`revalidateTag`, `revalidatePath`, `res.revalidate`)
- Middleware/proxy behavior
- `next.config` headers, rewrites, redirects
- `next/image` optimization
- Draft mode
- Mixed App + Pages router projects

## How caching works

- SQLite schema stores prerender entries, image entries, tag manifest metadata, and revalidation locks/targets.
- Prerender fallback outputs from `next build` are seeded into `cache.db` during `onBuildComplete`.
- In `cacheHandlerMode: 'http'` (default), cache handlers talk to an internal authenticated HTTP endpoint (`/_adapter/cache` by default), which avoids direct `bun:sqlite` imports in Edge-oriented paths.
- In `cacheHandlerMode: 'sqlite'`, handlers read/write SQLite directly.

## Runtime context path

### The problem

Next.js inlines `basePath` and `assetPrefix` into client-side bundles at build
time. Deploying the same image under `/dashboard` vs `/health-portal` causes
browsers to request `/_next/static/…` without the prefix, producing 404s for
all static assets.

### How it works

The adapter embeds a sentinel string (`/__BUN_ADAPTER_CONTEXT_PATH__` by
default) as the `basePath` and `assetPrefix` during `next build`. At startup,
`bun-dist/start.js`:

1. Reads `CONTEXT_PATH` from the environment (defaults to `''` = root).
2. Copies `bun-dist/template/` → `bun-dist/live/` (pristine build artifacts).
3. Replaces every occurrence of the sentinel in `.js`, `.json`, and `.html`
   files inside `live/` with the resolved context path.
4. Writes `bun-dist/live/.context-path` as a marker for the runtime server.
5. Boots `bun-dist/live/server.js`.

The runtime server also strips the context path prefix from every incoming
request URL before passing it to Next.js, handling middleware-generated URLs
and server action redirects that the static replacement cannot reach.

### Usage

```bash
# Root path (default)
bun bun-dist/start.js

# Sub-path
CONTEXT_PATH=/dashboard bun bun-dist/start.js
```

`bun bun-dist/server.js` still works unchanged for deployments that do not
need context path support.

To opt out of sentinel injection entirely:

```ts
createBunAdapter({ contextPathPlaceholder: false })
```

To use a custom sentinel (must be unique enough to avoid accidental matches):

```ts
createBunAdapter({ contextPathPlaceholder: '/__MY_APP_BASE__' })
```

The exported `CONTEXT_PATH_PLACEHOLDER` constant equals the default sentinel
and can be referenced in tests or tooling:

```ts
import { CONTEXT_PATH_PLACEHOLDER } from 'adapter-bun';
```

### Docker example

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY . .
ENV CONTEXT_PATH=
CMD ["bun", "bun-dist/start.js"]
```

```bash
docker run -e CONTEXT_PATH=/dashboard my-image
```

### PM2 example

```yaml
# ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'my-app',
    script: 'bun',
    args: 'bun-dist/start.js',
    env: { CONTEXT_PATH: '/dashboard' },
  }],
};
```

## Public exports

`adapter-bun` exports:

- default adapter (`bunAdapter`)
- `createBunAdapter`
- `ADAPTER_NAME`
- `CONTEXT_PATH_PLACEHOLDER`
- `DEFAULT_BUN_ADAPTER_OUT_DIR`
- `SqlitePrerenderCacheStore`
- `SqliteImageCacheStore`
- `createSqliteCacheStores`
- types: `BunAdapterOptions`, `BunDeploymentManifest`, `BunStaticAsset`, `SqliteCacheOptions`

## Repo layout

```txt
src/
  adapter.ts
  manifest.ts
  staging.ts
  types.ts
  runtime/
    server.ts
    isr.ts
    sqlite-cache.ts
    cache-store.ts
    cache-handler.ts
    cache-handler-http.ts
    cache-handler-registration.ts
    incremental-cache-handler.ts
    incremental-cache-handler-http.ts
    incremental-cache-codec.ts
    cache-http-client.ts
    cache-http-server.ts
    cache-http-protocol.ts
    binary.ts
```

## Development

```bash
# install deps
bun install

# build dist/
bun run build

# type-check
bun run typecheck
```

Fixture live validation:

```bash
cd fixtures/verbose-mixed-router
bun run build:e2e
```

Next.js deploy harness (full local E2E against Next repo):

```bash
./scripts/e2e-local.sh [next-ref] [test-file]
```
