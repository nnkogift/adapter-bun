# Next.js Internal API Audit (adapter-bun)

Date: 2026-03-23

## Scope

Audited the adapter/runtime for imports of `next/dist/*` (private Next.js internals), replaced what could be moved to local/public-compatible code, and documented unresolved internals below.

## Replaced Internal Usage

The following categories were migrated off `next/dist/*` imports:

- App Router request header/query constants (`ACTION_HEADER`, `RSC_HEADER`, etc.)
- Query normalization helper (`normalizeNextQueryParam`)
- Fallback route param token generation (`createOpaqueFallbackRouteParams`)
- RSC cache-busting helpers (`computeCacheBustingSearchParam`, `setCacheBustingSearchParamWithHash`)
- Dynamic route helpers (`isDynamicRoute`, `getNamedRouteRegex`, `getRouteMatcher`, `getSortedRoutes`)
- Middleware matcher construction (`getMiddlewareRouteMatcher`)
- Type-only dependencies from:
  - `next/dist/server/response-cache`
  - `next/dist/server/lib/incremental-cache`
  - `next/dist/server/lib/cache-handlers/types`

Compatibility layers added:

- `src/runtime/next-compat.ts`
- `src/next-compat-types.ts`

## Remaining Internal Usage (Needs Further Investigation)

### 1) Runtime polyfill bootstrap

- `src/runtime/server.ts`
  - `import 'next/dist/build/adapter/setup-node-env.external.js';`
- Why still internal:
  - This initializes Node-like runtime behavior expected by Next internals before request handling. No public Next API currently exposes this bootstrap directly.
- Investigation path:
  - Check if Next introduces a public adapter/runtime bootstrap API for non-Node runtimes.
  - Validate behavior if replaced with Bun-only shims (AsyncLocalStorage, process polyfills) before removing.

### 2) Edge incremental cache constructor

- `src/runtime/server.ts`
  - `require('next/dist/server/lib/incremental-cache')`
- Why still internal:
  - Adapter needs `IncrementalCache` constructor to wire edge revalidation/cache behavior with custom handler injection. No public constructor is currently available from `next` package exports.
- Investigation path:
  - Look for a public edge cache API in newer Next releases.
  - Evaluate whether adapter can fully own incremental cache logic (without Next constructor) while preserving Server Actions and ISR semantics.

### 3) Edge sandbox execution

- `src/runtime/server.ts`
  - `require('next/dist/server/web/sandbox')`
- Why still internal:
  - Required to execute middleware/edge functions with Next-compatible sandbox behavior.
- Investigation path:
  - Verify whether a public edge-runtime execution interface is exposed by Next.
  - If not, consider adapter-owned sandbox bridge with conformance tests against middleware behavior.

### 4) `next/image` optimizer internals

- `src/runtime/server.ts`
  - `require('next/dist/server/image-optimizer.js')`
  - `require('next/dist/server/serve-static.js')`
- Why still internal:
  - Needed for canonical Next image param validation, fetching, optimization, and response behavior.
- Investigation path:
  - Check for public image optimizer API from Next.
  - Alternative: adapter-owned optimizer path that is behavior-compatible with Next image responses.

### 5) App-render scheduling patch target

- `src/runtime/server.ts`
  - `require('next/dist/server/app-render/app-render-scheduling.js')`
- Why still internal:
  - Bun-specific timer patch currently monkey-patches Next’s internal scheduling factory.
- Investigation path:
  - Track Bun/runtime fixes that make this patch unnecessary.
  - Request/track public extension point for scheduling customization.

## Current Status

- Remaining private imports are runtime-critical and were intentionally left in place.
- All replaceable internal imports identified in this pass were removed.
- Validation: `bun run typecheck` passes.
