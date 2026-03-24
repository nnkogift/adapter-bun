# Workflow 23476726637 Failing Specs

- Workflow: https://github.com/nextjs/adapter-bun/actions/runs/23476726637
- Source run date: 2026-03-24
- Local repro mode: workflow deploy env + `HEADLESS=0` + `--retries 0` + `--debug`

## Remaining Failures

| Spec | Failed Job | Job URL | Local Status | Notes |
| --- | --- | --- | --- | --- |
| `test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts` | `68311303607` | https://github.com/nextjs/adapter-bun/actions/runs/23476726637/job/68311303607 | fail | `defers fallback params to the runtime stage` times out waiting for `#cached-content` to become visible. |

## Notes

- Workflow failure inventory was pulled from all failed jobs in run `23476726637`; all failing specs except cached-navigations now pass locally under workflow-equivalent env.
- Cached-navigations investigation was run with deploy workflow env + `HEADLESS=0` + `--retries 0` + `--debug` and targeted adapter routing/cache/RSC debug logs.
- The failure does **not** currently reproduce as a cache-handler stale/miss bug: `cache-handler-http` shows expected hit behavior for cached entries during the failing navigation.
- The unresolved behavior is in fallback runtime-stage rendering for `/with-fallback-params/[slug]`: the blocked second navigation keeps `#cached-content` hidden even when fallback metadata is present. This needs deeper runtime-stage/fallback coordination investigation.
