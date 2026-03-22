# Workflow 23360036472 - Fixed and Passing

- Run: https://github.com/nextjs/adapter-bun/actions/runs/23360036472
- Updated: 2026-03-21 22:38 UTC

## Fixed (39)

1. `test/e2e/app-dir/hooks/hooks.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/hooks/hooks.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (26/26 tests)
   - Fix summary: normalized catch-all params from `routeMatches` into arrays for dynamic route pathnames so rewritten catch-all segments are preserved as path segments (not encoded scalar values).
2. `test/e2e/app-dir/edge-route-catchall/edge-route-catchall.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/edge-route-catchall/edge-route-catchall.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (2/2 tests)
   - Fix summary: merged `requestMeta.query` and `requestMeta.params` into the edge sandbox request URL so edge route handlers receive dynamic params consistently.
3. `test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy-in-src-dir.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy-in-src-dir.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (1/1 tests)
   - Fix summary: added node-runtime middleware/proxy execution path by loading `handler(request, ctx)` from node middleware outputs instead of rejecting non-edge middleware.
4. `test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (17 passed, 3 skipped)
   - Fix summary: stripped untrusted internal middleware headers from inbound external requests (including `x-middleware-set-cookie`) while preserving middleware-injected internal headers for downstream request processing.
5. `test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (3/3 tests)
   - Fix summary: normalized interception route pathnames for dynamic regex/param parsing by stripping interception markers (for example `'(.)'`) before matching, restoring params like `username` on intercepted dynamic routes.
6. `test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (14/14 tests)
   - Fix summary: normalized RSC response `content-type` for node runtime handlers even when Next writes headers via raw arrays/append paths, and restricted `routeMatches` query injection to dynamic route params so static interception requests no longer leak catch-all params into request meta.
7. `test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (2/2 tests)
   - Fix summary: passed after the RSC header normalization and route-match query filtering updates applied in `src/runtime/server.ts` (no additional code changes required for this suite).
8. `test/e2e/app-dir/parallel-routes-and-interception-catchall/parallel-routes-and-interception-catchall.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/parallel-routes-and-interception-catchall/parallel-routes-and-interception-catchall.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (1/1 tests)
   - Fix summary: passed with the same node runtime RSC header normalization in place (no extra code changes beyond `src/runtime/server.ts`).
9. `test/e2e/app-dir/parallel-routes-catchall-specificity/parallel-routes-catchall-specificity.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/parallel-routes-catchall-specificity/parallel-routes-catchall-specificity.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (1/1 tests)
   - Fix summary: passed with the current `src/runtime/server.ts` RSC handling fixes (no additional changes needed).
10. `test/e2e/app-dir/parallel-routes-css/parallel-routes-css.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/parallel-routes-css/parallel-routes-css.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (1/1 tests)
    - Fix summary: passed with the same runtime fixes in `src/runtime/server.ts` (no new code changes required).
11. `test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/prefetch-true-instant/prefetch-true-instant.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (2/2 tests)
    - Fix summary: aligned prefetch request metadata with Next behavior by marking `isPrefetchRSCRequest` only for `next-router-prefetch: 1` (not `2`), while keeping `segmentPrefetchRSCRequest` fallback only for `1`, which restored correct full-prefetch handling for instant routes.
12. `test/e2e/app-dir/prerender-encoding/prerender-encoding.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/prerender-encoding/prerender-encoding.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (1/1 tests)
    - Fix summary: added pathname encoding/decoding candidate resolution for route matching and output/static lookup, and allowed dynamic function fallback matching even when `matchedPathname` is a concrete prerendered path, so encoded prerender paths like `/sticks%20%26%20stones` resolve to `'/[id]'` with params.
13. `test/e2e/app-dir/proxy-nfc-traced/proxy-nfc-traced.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/proxy-nfc-traced/proxy-nfc-traced.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (1/1 tests)
    - Fix summary: passes with the current runtime routing/output resolution updates (no additional code changes required beyond `src/runtime/server.ts`).
14. `test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: restored segment-cache route resolution by normalizing interception-marker pathnames during dynamic fallback matching in `src/runtime/server.ts`.
15. `test/e2e/app-dir/segment-cache/deployment-skew/deployment-skew.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/deployment-skew/deployment-skew.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: passes with current runtime RSC request/response routing updates in `src/runtime/server.ts`.
16. `test/e2e/app-dir/segment-cache/max-prefetch-inlining/max-prefetch-inlining.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/max-prefetch-inlining/max-prefetch-inlining.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: passes with the current function output resolution and prefetch request-meta handling in `src/runtime/server.ts`.
17. `test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: passes after runtime routing/output matching fixes (no additional suite-specific code changes).
18. `test/e2e/app-dir/segment-cache/prefetch-runtime/prefetch-runtime.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/prefetch-runtime/prefetch-runtime.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: passes with current RSC prefetch metadata handling and output resolution updates.
19. `test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: passes after segment-cache route/output matching fixes in `src/runtime/server.ts`.
20. `test/e2e/app-dir/segment-cache/staleness/segment-cache-stale-time.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/staleness/segment-cache-stale-time.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: passes with current runtime prefetch and segment-cache request-meta fixes.
21. `test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: merged dynamic matcher params with filtered `routeMatches` params and skipped non-string route-match values to prevent placeholder params and decode crashes.
22. `test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: passes with the current routing and invocation meta updates in `src/runtime/server.ts`.
23. `test/e2e/app-dir/static-rsc-cache-components/static-rsc-cache-components.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/static-rsc-cache-components/static-rsc-cache-components.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: validated passing under deploy mode after runtime routing/output fixes.
24. `test/e2e/basepath/error-pages.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/basepath/error-pages.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: added basePath-aware 404/500 error output and static fallback resolution (`/docs/_error`, `/docs/404`, `/docs/500`) and invoked resolved error pathnames directly.
25. `test/e2e/basepath/router-events.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/basepath/router-events.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: passes with the same basePath-aware error and route resolution updates.
26. `test/e2e/config-promise-export/async-function.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/config-promise-export/async-function.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: added root-index aliasing for basePath paths (for example `/docs` <-> `/docs/index`) and included aliases in routing pathname candidates so basePath root requests resolve to prerendered index assets.
27. `test/e2e/config-promise-export/promise.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/config-promise-export/promise.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS`
    - Fix summary: validated the same basePath root-index aliasing fix for Promise-exported `next.config.js`.
28. `test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/resume-data-cache/resume-data-cache.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (5/5 tests)
    - Fix summary: validated passing with the current routing/request-meta normalization updates in `src/runtime/server.ts`.
29. `test/e2e/edge-api-endpoints-can-receive-body/index.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/edge-api-endpoints-can-receive-body/index.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (2/2 tests)
    - Fix summary: restored API function resolution for unmatched API pathnames via function-output fallback and validated request body handling for edge API entries.
30. `test/e2e/error-handler-not-found-req-url/error-handler-not-found-req-url.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/error-handler-not-found-req-url/error-handler-not-found-req-url.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (1/1 tests)
    - Fix summary: validated error page fallback/invocation behavior under the current direct-entry runtime flow.
31. `test/e2e/i18n-api-support/index.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/i18n-api-support/index.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (2/2 tests)
    - Fix summary: validated i18n API routing with API output fallback resolution and stable connection handling.
32. `test/e2e/i18n-preferred-locale-detection/i18n-preferred-locale-detection.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/i18n-preferred-locale-detection/i18n-preferred-locale-detection.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (3/3 tests)
    - Fix summary: validated locale-detection behavior with the current routing and i18n resolution flow.
33. `test/e2e/invalid-static-asset-404-app/invalid-static-asset-404-app-base-path.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/invalid-static-asset-404-app/invalid-static-asset-404-app-base-path.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (3/3 tests)
    - Fix summary: validated custom app 404 rendering for invalid non-asset paths while retaining plain-text asset 404 responses.
34. `test/e2e/invalid-static-asset-404-pages/invalid-static-asset-404-pages-asset-prefix.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/invalid-static-asset-404-pages/invalid-static-asset-404-pages-asset-prefix.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (3/3 tests)
    - Fix summary: validated pages-router 404 behavior so invalid asset paths return plain text `Not Found` while non-asset paths render the expected page response.
35. `test/e2e/middleware-custom-matchers/test/index.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/middleware-custom-matchers/test/index.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (7 passed, 3 skipped)
    - Fix summary: validated matcher behavior with current middleware route matching and prefetch/socket handling updates.
36. `test/e2e/middleware-general/test/index.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/middleware-general/test/index.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (64/64 tests)
    - Fix summary: stabilized middleware request handling by closing known stale-connection paths (prefetch/middleware/decode-failure) while preserving route-param behavior.
37. `test/e2e/middleware-responses/test/index.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/middleware-responses/test/index.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (14/14 tests)
    - Fix summary: validated middleware response header/cookie behavior with current runtime routing and response writing logic.
38. `test/e2e/og-routes-custom-font/og-routes-custom-font.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/og-routes-custom-font/og-routes-custom-font.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (1/1 tests)
    - Fix summary: validated edge and node OG handlers with direct entry invocation and current edge runtime handling.
39. `test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts`
    - Validation command: `node run-tests.js --test-pattern test/e2e/streaming-ssr-edge/streaming-ssr-edge.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
    - Result: `PASS` (5/5 tests)
    - Fix summary: fixed sequential request `ECONNRESET` by explicitly closing edge runtime function responses (`connection: close`) to avoid keep-alive reuse of stale sockets.
