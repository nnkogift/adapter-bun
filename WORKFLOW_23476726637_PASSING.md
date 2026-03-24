# Workflow 23476726637 Passing Specs

- Workflow: https://github.com/nextjs/adapter-bun/actions/runs/23476726637
- Validation mode: workflow deploy env + `HEADLESS=0` + `--retries 0` + `--debug`

## Passing After Investigation

| Spec | Repro Command | Result | Notes |
| --- | --- | --- | --- |
| `test/e2e/app-dir/app-catch-all-optional/app-catch-all-optional.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/app-catch-all-optional/app-catch-all-optional.test.ts` | pass | Stable pass with workflow-equivalent env. |
| `test/e2e/app-dir/app-root-params-getters/simple.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/app-root-params-getters/simple.test.ts` | pass | Fixed placeholder/internal query leakage into request metadata. |
| `test/e2e/app-dir/app/index.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/app/index.test.ts` | pass | Fixed app-route query pollution by scoping internal dynamic query param normalization to pages outputs and preserving empty-string query values. |
| `test/e2e/app-dir/not-found-with-pages-i18n/not-found-with-pages.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/not-found-with-pages-i18n/not-found-with-pages.test.ts` | pass | Fixed output selection to prefer app route handlers/pages over pages catch-all when resolveRoutes returns a pages exact match but request pathname maps to an app output. |
| `test/e2e/i18n-api-support/index.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/i18n-api-support/index.test.ts` | pass | Fixed unresolved dynamic API output fallback in i18n deploy mode by adding adapter-owned dynamic output matcher fallback for API paths. |
| `test/e2e/app-dir/layout-params/layout-params.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/layout-params/layout-params.test.ts` | pass | Stable pass with workflow-equivalent env. |
| `test/e2e/app-dir/parallel-route-not-found-params/parallel-route-not-found-params.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/parallel-route-not-found-params/parallel-route-not-found-params.test.ts` | pass | Stable pass with workflow-equivalent env. |
| `test/e2e/app-dir/parallel-routes-generate-static-params/parallel-routes-generate-static-params.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/parallel-routes-generate-static-params/parallel-routes-generate-static-params.test.ts` | pass | Stable pass with workflow-equivalent env. |
| `test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts` | pass | Stable pass with workflow-equivalent env. |
| `test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/segment-cache/vary-params-base-dynamic/vary-params-base-dynamic.test.ts` | pass | Fixed stale `use cache` entry handling in adapter cache handlers (`cache-handler-http.ts` and `cache-handler.ts`) to return miss after `revalidateAt`, allowing fresh revalidation instead of repeatedly serving old markers. |
| `test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts` | pass | Stable pass with workflow-equivalent env. |
| `test/e2e/app-dir/use-params/use-params.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/app-dir/use-params/use-params.test.ts` | pass | Stable pass with workflow-equivalent env. |
| `test/e2e/edge-pages-support/index.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/edge-pages-support/index.test.ts` | pass | Fixed internal route query key normalization/filtering for static vs dynamic matches. |
| `test/e2e/middleware-rewrites/test/index.test.ts` | `node run-tests.js --type e2e --debug --retries 0 -c 1 test/e2e/middleware-rewrites/test/index.test.ts` | pass | Resolved rewrite output selection/query normalization regressions; rerun passes (`56 passed`, `2 skipped`) with workflow-equivalent env. |
