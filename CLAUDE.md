# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

`adapter-bun` is a Next.js adapter that enables running production Next.js builds on Bun. It hooks into the Next.js build process and generates a self-contained `bun-dist/` runtime package.

## Commands

```bash
bun run build       # Clean dist/ and compile TypeScript
bun run build:src   # Compile TypeScript only (bunx tsc -p tsconfig.build.json)
bun run typecheck   # Type-check without emitting
bun run clean       # Remove dist/ directory
bun test            # Run Bun test suite
```

There are no unit tests yet. E2E tests run via the fixture app:

```bash
cd fixtures/verbose-mixed-router
bun run build:e2e   # Full build + E2E fixture
bun run e2e:live    # Run assertions against a live server
```

The E2E test manifest at `test/deploy-tests-manifest.adapter-bun.json` documents known-flaky tests that are excluded.

## Architecture

The adapter operates in two phases:

### Build Phase (`src/adapter.ts`)

`NextAdapter` implementation with two hooks:
- `modifyConfig()` — Injects the cache handler path, configures server actions CSRF, and stages runtime modules into `bun-dist/runtime/` before the Next.js build runs.
- `onBuildComplete()` — After the Next.js build: seeds SQLite cache from prerender-manifest.json, stages final runtime modules, generates `deployment-manifest.json` and `runtime-next-config.json`, writes `server.js`.

Supporting build-time modules:
- `src/manifest.ts` — Generates `bun-dist/deployment-manifest.json`
- `src/staging.ts` — Copies static assets from `.next/` to `bun-dist/static/`
- `src/types.ts` — TypeScript interfaces (`BunAdapterOptions`, `BunDeploymentManifest`)

### Runtime Phase (`src/runtime/`)

Entry point is the generated `bun-dist/server.js`, which loads `server.ts` — a Node.js HTTP server that boots Next.js and reads config from `deployment-manifest.json`.

**Dual-mode cache system** — chosen via `cacheHandlerMode` in adapter options:

- **HTTP mode** (default): Cache operations go through an internal `/_adapter/cache` HTTP endpoint. Avoids Edge runtime issues with direct storage imports.
  - `cache-handler-http.ts` — implements the Next.js cache handler interface
  - `cache-http-client.ts` — makes fetch requests to the cache endpoint
  - `cache-http-server.ts` — serves `/_adapter/cache`
  - `cache-http-protocol.ts` — shared request/response types

- **SQLite mode**: Direct access via Bun's native `bun:sqlite`.
  - `cache-handler.ts` — Next.js cache handler backed by SQLite
  - `sqlite-cache.ts` — schema, WAL pragmas, busy timeout, tables: `cache_entries`, `revalidate_targets`, `revalidate_target_tags`, `revalidate_locks`
  - `cache-store.ts` — singleton accessor

**Handler wiring:**
- `cache-handler-registration.ts` — Registers handlers globally via `Symbol.for('@next/cache-handlers')` (Next.js's hook)
- `incremental-cache-handler.ts` — Maps Next's `IncrementalCache` interface to the cache store
- `incremental-cache-codec.ts` — Encodes/decodes cache entries

**Utilities:**
- `isr.ts` — Types: `PrerenderCacheEntry`, `ImageCacheEntry`, tag manifests
- `binary.ts` — UTF-8 / Base64 encode/decode helpers

### Build Output (`bun-dist/`)

```
bun-dist/
  server.js                    # Entry point (generated)
  cache.db                     # SQLite cache, seeded at build time from prerender-manifest.json
  deployment-manifest.json     # Runtime config: port, hostname, cache mode, static assets
  runtime-next-config.json     # Serialized next.config
  runtime/                     # Staged cache handler modules
  static/                      # Staged Next.js + public assets
```

## Adapter Options

Passed to `createBunAdapter()` in `next.config`:

| Option | Default | Purpose |
|---|---|---|
| `outDir` | `bun-dist` | Output directory |
| `port` | `3000` | Server port |
| `hostname` | `0.0.0.0` | Bind hostname |
| `deploymentHost` | — | CSRF allowlist host for Server Actions |
| `cacheHandlerMode` | `'http'` | `'http'` or `'sqlite'` |
| `cacheEndpointPath` | `/_adapter/cache` | Internal cache endpoint |
| `cacheAuthToken` | — | Shared secret for cache HTTP endpoint |

## Runtime Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | Override manifest port |
| `NEXT_HOSTNAME` | Override hostname for origin calculation |
| `NEXT_PROJECT_DIR` | Override inferred project root |
| `BUN_ADAPTER_CACHE_HTTP_TOKEN` | Override cache auth token |
| `BUN_ADAPTER_KEEP_ALIVE_TIMEOUT` | HTTP keep-alive timeout (ms) |
| `BUN_ADAPTER_CACHE_DB_PATH` | Override cache.db path |
| `BUN_ADAPTER_DEPLOYMENT_HOST` | Set deployment host for CSRF allowlist |

## Key Patterns

- **Module staging happens twice**: in `modifyConfig()` and again in `onBuildComplete()`. This is intentional — Next.js needs the handler path during config resolution, but the final copy happens post-build.
- **ISR revalidation uses a lock table** (`revalidate_locks` in SQLite) to prevent concurrent revalidation of the same path/tag.
- **Cache DB is seeded at build time** from `prerender-manifest.json` — the server starts with prerender fallbacks already populated.
- **Package manager: pnpm** (`pnpm 9.6.0` specified in `package.json`). The project uses Bun as runtime but pnpm for dependency management.
