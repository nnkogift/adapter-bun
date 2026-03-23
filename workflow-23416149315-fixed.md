# Workflow 23416149315 - Fixed and Passing

- Run: https://github.com/nextjs/adapter-bun/actions/runs/23416149315
- Updated: 2026-03-23 00:53 UTC

## Fixed (5)

1. `test/e2e/app-dir/optimistic-routing/optimistic-routing.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/optimistic-routing/optimistic-routing.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (22s)
   - Fix summary: fixed in `src/runtime/server.ts` by adding an unmatched-route function-output fallback and by allowing compatible dynamic-template fallback resolution (instead of early null) when routing returns partially concrete dynamic paths.
2. `test/e2e/i18n-api-support/index.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/i18n-api-support/index.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (9s)
   - Fix summary: fixed in `src/runtime/server.ts` by adding an unmatched-route function-output fallback and by allowing compatible dynamic-template fallback resolution (instead of early null) when routing returns partially concrete dynamic paths.
3. `test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (12s)
   - Fix summary: fixed in `src/runtime/server.ts` by adding an unmatched-route function-output fallback and by allowing compatible dynamic-template fallback resolution (instead of early null) when routing returns partially concrete dynamic paths.
4. `test/e2e/app-dir/ppr-root-param-fallback/ppr-root-param-fallback.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/ppr-root-param-fallback/ppr-root-param-fallback.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (12s)
   - Fix summary: fixed in `src/runtime/server.ts` by adding an unmatched-route function-output fallback and by allowing compatible dynamic-template fallback resolution (instead of early null) when routing returns partially concrete dynamic paths.
5. `test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts`
   - Validation command: `node run-tests.js --test-pattern test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts -c 1 --type e2e --retries 0 --debug` (with `.github/workflows/test-e2e-deploy.yml` env)
   - Result: `PASS` (18s)
   - Fix summary: fixed in `src/runtime/server.ts` by adding an unmatched-route function-output fallback and by allowing compatible dynamic-template fallback resolution (instead of early null) when routing returns partially concrete dynamic paths.
