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

## Complementary mitigation: per-identity credential separation

Reducing GraphQL demand on the shared bucket only solves half the problem. The other half is **whose bucket is being drained.** Today every dispatched swarm worker inherits the maintainer's `gh auth` PAT, so:

- All N concurrent workers + the maintainer's interactive session compete for the same 5000-req/hr GraphQL bucket on a single user identity.
- Bucket depletion blocks the human's read/review workflow (e.g. `gh issue create` filing #979 today).
- Audit logs cannot distinguish "the maintainer did X" from "an autonomous worker did X" -- everything attributes to the same identity.

The architectural fix is to give swarm workers a **distinct GitHub identity** (bot account or GitHub App installation token) with its own rate-limit bucket and revocable credentials, and reserve the maintainer's PAT for human-driven work (review, merge, manual triage). This is complementary to the REST migration above: even with perfect REST hygiene the shared identity still couples human and machine traffic on one bucket.

This is captured architecturally in #588 (agent identity pattern -- distinct, attestable, short-lived) and #806 (executor-layer-credentials -- secrets bound at invocation, not in agent context). #585 covers cloud-agent credential hygiene. #519 / #520 frame the same constraint at the LLM-provider layer (rate limits as architecture, multi-provider routing). Adopting per-identity credentials for swarm dispatch operationalises those patterns specifically for the GitHub GraphQL bucket drain this issue tracks.

### Sub-scope (separate from the SCM/REST work above)

- Document the recommended swarm-worker identity model in `patterns/multi-agent.md` (or wherever #588 lands).
- Add maintainer-facing guidance: how to provision a bot account or GitHub App installation token, scope permissions, and inject the credential into worker dispatch envelopes (rather than relying on the maintainer's `gh auth` state).
- Update `templates/agent-prompt-preamble.md` to reference the per-identity expectation alongside the existing REST-default / no-Draft-retoggle / rate-limit-throttle rules from #954.
- Decide whether to track this as its own issue (carved out of this one) or keep it folded in here -- this complementary mitigation is wider in scope than the narrow REST-migration slice and may warrant its own issue once the SCM/REST work lands.

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

