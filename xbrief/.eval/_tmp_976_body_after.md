## Summary

#884 (ghx adoption) and #961 (REST fallback helpers + `release_publish.py` REST refactor) reduced the GraphQL burn rate, but they did not eliminate it. The remaining in-repo hotspot is the SCM stub / live SCM smoke path:

- `scripts/scm.py` still shells out to `gh issue list` / `gh issue view`
- `tasks/scm.yml` still documents the stub as a thin wrapper over `ghx|gh issue list/view/close/edit`
- `tests/integration/test_scm_smoke.py` still exercises that live path against `deftai/directive`

When the shared GitHub GraphQL bucket is depleted, that smoke test fails and agent `task check` runs hit the same rate-limit wall even after #961 lands.

This issue is the narrow "remaining bucket drain" follow-up to #884 / #961, and the concrete near-term slice of the broader `scm:*` abstraction tracked in #881.

## Problem

Directive still has at least one live path that depends on GraphQL-backed `gh` surfaces:

- `scripts/scm.py` Story 1 stub (`issue list`, `issue view`, `issue close`, `issue edit`) is a direct subprocess wrapper around `ghx|gh issue ...`
- the smoke test `tests/integration/test_scm_smoke.py::test_scm_issue_view_returns_nonempty_json` shells out through that wrapper to prove the round-trip

Today, after #961 landed, the shared GraphQL bucket still re-exhausted. The clearest repo-local symptom was:

- `task check` on the #961 P1-fix branch failed only because `tests/integration/test_scm_smoke.py::test_scm_issue_view_returns_nonempty_json` hit live GraphQL with `graphql=0/5000`

So:

- #884 solved read caching and coalescing for REST-like `gh` usage
- #961 solved one concrete release-publish GraphQL failure mode
- the SCM stub + live smoke path still leaks GraphQL demand into the default maintainer workflow

## Important distinction

Not every GraphQL consumer is removable:

- `markPullRequestReadyForReview` (`gh pr ready`) is GraphQL-only on GitHub's side
- review approval mutations are also GraphQL-only

Those are unavoidable and should be minimized / budgeted.

The SCM stub path is different: it is an avoidable GraphQL drain and should move to explicit REST or be skipped when the bucket is empty.

## Evidence from this session

1. `gh api rate_limit` repeatedly showed `graphql=0/5000` while `core` remained healthy.
2. `task release:publish -- 0.26.1` failed before #961 because `release_publish.py` called `gh release view` / `gh release edit` (GraphQL). #961 fixed that.
3. After #961 landed, `task check` for the P1-polish branch still failed only at `tests/integration/test_scm_smoke.py`, proving another GraphQL-backed path remains.
4. Profiling / live inspection showed `scripts/scm.py` still wraps raw `gh issue list/view` rather than a REST helper.
5. While filing #979 today (a routine `gh issue create`) the call failed with `GraphQL: API rate limit already exceeded`; the REST fall-through (`gh api -X POST repos/.../issues --input <json>`) succeeded immediately. Concrete confirmation that even simple maintainer workflows are now GraphQL-coupled in ways the user does not see until the bucket is empty.

## Proposed scope

1. Remove GraphQL-backed `gh issue list` / `gh issue view` dependence from the SCM stub where possible.
   - Preferred: explicit `gh api` REST endpoints
   - Acceptable: route through `scripts/gh_rest.py` where the helper surface already exists, and extend that module only if the extension fits the issue/PR charter cleanly
2. Make `tests/integration/test_scm_smoke.py` bucket-aware.
   - If the smoke still requires GraphQL after the SCM refactor, skip cleanly when `graphql.remaining == 0`
   - Preferably, make the smoke exercise a REST-backed path instead so GraphQL depletion no longer fails unrelated PRs
3. Document the remaining GraphQL-only surfaces explicitly so future agents know which operations are budgeted and which are accidental drain

## Complementary mitigation

Per-identity credential separation for swarm workers has been carved out into
its own issue: #983. That track is complementary to and does not block the
SCM/REST migration in this issue.

## Non-goals

- Full `scm:*` redesign across all platforms (that is #881)
- Eliminating all GraphQL use from directive (some GitHub mutations are GraphQL-only)
- Reworking Greptile / GitHub App / external bot traffic
- Implementing per-identity credential plumbing in this PR -- the credential-separation work above is a complementary track, not a blocker for the REST migration

## Why this should exist separately from #881

#881 is the broad strategic abstraction issue.
This issue is the tactical reliability slice:

- small enough for a patch release
- directly tied to a reproduced maintainer pain point
- motivated by a concrete post-#961 failure in the default `task check` flow

## Related

- #881 -- broad `scm:*` task namespace / abstraction
- #884 -- ghx adoption
- #961 -- REST fallback helpers + `release_publish.py` REST refactor
- #975 -- triage test performance hotspot profiling (separate concern surfaced in the same session)
- #979 -- user-facing docs gap for the refinement/triage workflow that prevents this drain
- #588 -- agent identity pattern (distinct attestable identity per agent; credential-separation rationale)
- #806 -- executor-layer-credentials (secrets bound at invocation layer, not in agent context)
- #585 -- credential hygiene standard for cloud agent dispatch
- #519 -- rate limiting as a first-class architectural constraint for multi-agent guidance
- #520 -- multi-provider routing as the production solution for large-scale swarms
- #954 / #966 -- canonical orchestrator preamble (REST-default, rate-limit-throttle, dispatcher-lifecycle-hygiene rules)
- #845 -- pre-ingest triage workflow (the cache-backed flow that lets agents work without live GraphQL queries per decision)

