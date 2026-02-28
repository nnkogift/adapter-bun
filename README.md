# adapter-bun

A Next.js adapter that runs your app on [Bun](https://bun.sh).

Takes the output of `next build` and produces a self-contained `bun-dist/` directory you can start with `bun bun-dist/server.js`.

## Quick start

Install the adapter alongside Next.js:

```bash
bun add adapter-bun
```

Point your `next.config.ts` at it:

```ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  experimental: {
    adapterPath: require.resolve('adapter-bun'),
  },
};

export default config;
```

Build and run:

```bash
bun --bun next build
bun bun-dist/server.js
```

## Configuration

Pass options to `createBunAdapter()` in your adapter entry:

```ts
import { createBunAdapter } from 'adapter-bun';

export default createBunAdapter({
  outDir: 'bun-dist',       // output directory (default: 'bun-dist')
  port: 3000,               // listen port (default: 3000)
  hostname: '0.0.0.0',      // bind address (default: '0.0.0.0')
  deploymentHost: 'app.example.com', // CSRF allow-list for Server Actions
});
```

`deploymentHost` can also be set via the `BUN_ADAPTER_DEPLOYMENT_HOST` environment variable.

## What it supports

- **App Router** — static pages, dynamic SSR, streaming, `generateStaticParams`
- **Pages Router** — `getStaticProps`, `getServerSideProps`, `getStaticPaths` with fallback
- **API Routes** — both app route handlers and pages API routes
- **Middleware** — edge middleware with rewrites, redirects, and response headers
- **ISR** — time-based revalidation and on-demand revalidation via `revalidateTag()`, `revalidatePath()`, and `res.revalidate()`
- **Image optimization** — `next/image` backed by Sharp
- **Draft mode** — preview bypass cookies
- **`next.config` routing** — headers, redirects, rewrites (including external rewrites)
- **Mixed routers** — app and pages router in the same project
- **Edge runtime** — edge functions and middleware run in an isolated `edge-runtime` sandbox

## How it works

### Build time

The adapter hooks into Next.js via the `onBuildComplete` callback. It takes the `.next/` build output and produces a deployment-ready directory:

```
bun-dist/
  server.js                 # entry point (Bun.serve)
  deployment-manifest.json  # routes, functions, assets, config
  cache.db                  # SQLite — prerender + image cache
  bundle/                   # function artifacts (route handlers)
  static/                   # static assets (/_next/static + public/)
  runtime/                  # router, cache, invokers
  node_modules/             # traced dependencies
```

Functions are consolidated into a shared `bundle/` directory with deduplicated assets. Prerender seeds (SSG pages) are written into the SQLite cache so they're served immediately on first request.

### Runtime

`server.js` starts a Bun HTTP server. Each request flows through:

1. **Route resolution** — `@next/routing` matches the URL against the route graph (middleware routes, file-based routes, dynamic routes, config rewrites/redirects)
2. **Middleware** — if the app has middleware, it runs in an edge runtime sandbox and can rewrite, redirect, or modify headers
3. **Dispatch** — the matched route is handed to the appropriate handler:
   - **Static** — file served from `static/` with appropriate cache headers
   - **Prerender (ISR)** — served from SQLite cache; stale entries trigger background revalidation
   - **Function** — Node.js handler invoked via a per-request HTTP server; edge handlers run in `edge-runtime`
   - **Image** — optimized via Sharp with its own cache layer
   - **External rewrite** — proxied to the external URL
4. **Cache evaluation** — prerender responses are checked against the tag manifest for staleness/expiration before serving

### Caching

The adapter uses SQLite (`cache.db`) for persistent caching:

- **Prerender cache** — stores rendered pages with TTL and tag-based invalidation
- **Image cache** — stores optimized images with TTL
- **Tag manifest** — tracks `revalidateTag()` / `revalidatePath()` invalidations
- **Revalidation locks** — prevents duplicate background regeneration

When `revalidateTag()` or `revalidatePath()` is called inside a route handler or server action, the adapter bridges Next.js's in-memory tag manifest with the SQLite store so invalidations persist across requests.

### On-demand revalidation

Three mechanisms are supported:

- **`revalidateTag(tag)`** / **`revalidatePath(path)`** from `next/cache` — works inside route handlers and server actions; synced to SQLite via the tag manifest bridge
- **`res.revalidate(path)`** — pages router ISR; the adapter patches `fetch` to rewrite self-referencing HTTPS calls to HTTP
- **Manual endpoint** (`/_next/revalidate`) — accepts `POST` with `{ tags, paths }` for external revalidation triggers

## Project structure

```
src/
  adapter.ts                # build hook + server template
  manifest.ts               # deployment + router manifest generation
  staging.ts                # stages assets, functions, prerender seeds
  types.ts                  # adapter types
  runtime/
    router.ts               # request router (createRouterRuntime)
    isr.ts                  # prerender cache logic + types
    image.ts                # image optimization cache
    sqlite-cache.ts         # SQLite cache stores
    function-invoker.ts     # dispatches to node/edge invokers
    function-invoker-node.ts   # Node.js function runtime
    function-invoker-edge.ts   # Edge function runtime + middleware
    function-invoker-shared.ts # shared invoker utilities
    static.ts               # static file serving
    revalidate.ts           # background revalidation queue
    tag-manifest-bridge.ts  # syncs Next.js revalidateTag to SQLite
    next-routing.ts         # lazy-loads @next/routing
    types.ts                # runtime types
```

## Development

```bash
# build the adapter
bun run build

# type-check
bun run typecheck

# build + run the test fixture
cd fixtures/verbose-mixed-router
bun --bun next build
bun bun-dist/server.js

# run validation tests (server must be running)
bun run validate:runtime
```
