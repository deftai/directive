# Integration e2e coverage map (#1838 s8)

| Python integration test | TS integration-e2e spec | Notes |
| --- | --- | --- |
| `tests/integration/test_cache_e2e.py` | `cache-e2e.test.ts` | End-state via `cacheFetchAll` / `cacheGet` / `cacheInvalidate` + `cache/main` CLI |
| `tests/integration/test_cache_quarantine.py` | `cache-quarantine.test.ts` | Rate-limit retry, partial failure, scan-fail, entry-cap eviction |
| `tests/integration/test_consumer_tasks.py` | `consumer-tasks.test.ts` | `dispatchTaskCheck` helper mirrors `_project_context`; scope/ingest/reconcile/prd via TS modules |
| `tests/integration/test_scm_smoke.py` | `scm-smoke.test.ts` | Hermetic `probeRateLimit` + `scm/main` `--rest` dispatch (live network case remains Python-only) |
| `tests/integration/test_triage_smoke.py` | `triage-smoke.test.ts` | `bulkAction` + filesystem cache/candidates log |
| `tests/integration/test_triage_bootstrap_at_scale.py` | `triage-bootstrap-at-scale.test.ts` | Fake timers for watchdog; no real sleeps (#975) |

## Partial overlap with existing TS unit tests (recorded for Wave 9)

| Python flow | Existing TS unit coverage | Integration-e2e still adds |
| --- | --- | --- |
| Cache fetch/idempotency | `cache/fetch-branches.test.ts`, `cache/main-branches.test.ts` | Full unified-layout + audit + invalidate idempotency chain |
| Bootstrap watchdog | `triage/bootstrap/index.test.ts` | 60-issue scale + progress emission + end-to-end `runBootstrap` timeout branch |
| Bulk defer | `triage/bulk/index.test.ts` | Cache-only defer audit parity with Python smoke fixtures |
| SCM REST view | `scm/rest-dispatch.test.ts`, `scm/main-branches.test.ts` | Subprocess-style `scm/main` stdout contract |
