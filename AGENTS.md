# Deft — Development Framework (deft repo)

You are working inside the deft framework repository itself.
Full guidelines: main.md

## First Session (deft development)

**Headless bypass**: If you have been dispatched with a specific task (e.g. cloud agent, CI agent, scheduled run), skip the onboarding checks below and proceed directly to your task. The onboarding flow is for interactive sessions only.

Check what exists before doing anything else:

**USER.md missing** (~/.config/deft/USER.md or %APPDATA%\deft\USER.md):
→ Read skills/deft-directive-setup/SKILL.md and start Phase 1 (user preferences)

**USER.md exists, PROJECT-DEFINITION.vbrief.json missing** (./vbrief/):
→ Read skills/deft-directive-setup/SKILL.md and start Phase 2 (project definition)

## Returning Sessions

When all config exists: read the guidelines, your USER.md preferences, and PROJECT-DEFINITION.vbrief.json, then continue with your task.

~ Run `skills/deft-directive-sync/SKILL.md` to pull latest framework updates and validate project files.

### Deft Alignment Confirmation

! At the start of each interactive session, after loading AGENTS.md, confirm to the user that Deft Directive is active. The confirmation must be unambiguous -- for example: "Deft Directive active -- AGENTS.md loaded."

! If the agent detects a context window shift or is asked "are you using Deft?", re-confirm alignment by stating that Deft Directive is active and AGENTS.md was loaded.

⊗ Begin an interactive session without confirming Deft alignment to the user.

Note: A true UI indicator (e.g. Warp status bar) is deferred to Phase 5. This is a behavioral rule only.

## Session-start ritual (#1149)

! On every interactive session start, the agent performs these four steps in the canonical order below. Each step is a hand-off into a more specific rule documented elsewhere in this file; the ordering itself is the rule and downstream gates (Implementation Intent Gate, branch-policy gate, the pre-`start_agent` gate stack) rely on it.

1. **Deft alignment confirmation** -- see `### Deft Alignment Confirmation` above (#134).
2. **Branch-policy disclosure** -- see the `Branch Policy Disclosure (session start)` block under `## Development Process` (#746 / #747).
3. **`task triage:summary` one-line state** -- emit the current triage-cache one-liner (D2 / #1122). D2 suppresses repeat emission within 4 hours unless the cache state changed. The headline `in-flight` count is **filesystem-truth** -- a live count of `vbrief/active/*.vbrief.json` files with `plan.status == "running"` (#1270). When that count diverges from the legacy audit-log-derived cache-scoped view, a second `[triage:scope]` line surfaces the gap; the wording distinguishes whether `plan.policy.triageScope[]` is explicitly configured (`outside plan.policy.triageScope[]`) or absent/empty/default (`not configured`).
4. **`task verify:cache-fresh` warning** -- printed only when the cache is stale (D5 / #1127); silent on a fresh cache.

⊗ Reorder, skip, or merge the four steps above without an explicit operator override -- the canonical order is what makes the downstream gate stack composable.

## Skill Completion Gate

! When a skill's final step is complete, explicitly confirm skill exit and provide chaining instructions if applicable. The confirmation must be unambiguous -- for example: "{skill-name} complete -- exiting skill." followed by what the user/agent should do next (e.g. wait for PR review, return to monitor, chain into another skill).

⊗ Exit a skill silently without confirming completion or providing next-step instructions.

## Before Improvising

- ! Before designing a multi-step workflow from scratch, scan `skills/` for an existing skill that covers the task — skills are versioned, tested, and encode lessons from prior runs
- ⊗ Improvise a multi-step workflow without first checking `skills/` for coverage

## Cache-as-authoritative work selection (#1149)

! When the operator asks "what should I work on next?" / "build a cohort" / "what's the queue?", the agent MUST run `task triage:queue --limit=10` (D11 / #1128) and present the ranked list before suggesting anything else. The agent MUST NOT recommend work from memory or open-GitHub-issue intuition.

⊗ Recommend a specific issue or vBRIEF without consulting `task triage:queue` (or showing the operator the result of the consultation).

## Skill Routing

When user input matches a trigger keyword, read the corresponding skill:

- "review cycle" / "check reviews" / "run review cycle" → `skills/deft-directive-review-cycle/SKILL.md`
- "swarm" / "parallel agents" / "run agents" → `skills/deft-directive-swarm/SKILL.md` — chains to `deft-directive-review-cycle` at Phase 5; Phase 0 is queue-driven (see N2 / #1142)
- "decompose" / "story decomposition" / "swarm readiness" → `skills/deft-directive-decompose/SKILL.md` — converts phase/epic scopes into swarm-ready story vBRIEFs before swarm allocation.
- "refinement" / "reprioritize" / "refine" → `skills/deft-directive-refinement/SKILL.md` — chains to `deft-directive-review-cycle` at exit; Phase 0 consults the triage cache first (see N1 / #1141)
- "build" / "implement" / "implement spec" → `skills/deft-directive-build/SKILL.md`
- "cost" / "budget" / "pre-build cost" / "how much will this cost" → `skills/deft-directive-cost/SKILL.md`
- "setup" / "bootstrap" / "onboard" → `skills/deft-directive-setup/SKILL.md`
- "sync" / "good morning" / "update deft" / "update vbrief" / "sync frameworks" → `skills/deft-directive-sync/SKILL.md`
- "pre-pr" / "quality loop" / "rwldl" / "self-review" → `skills/deft-directive-pre-pr/SKILL.md`
- "interview loop" / "q&a loop" / "run interview loop" → `skills/deft-directive-interview/SKILL.md`
- "release" / "cut release" / "v0.X.Y" / "publish release" → `skills/deft-directive-release/SKILL.md` — operationalizes the `task release` / `task release:publish` / `task release:rollback` / `task release:e2e` surface (#74 + #716 safety hardening); re-uses the `skills/deft-directive-swarm/SKILL.md` Phase 6 Step 5 Slack announcement template
- "glossary" / "ubiquitous language" / "domain model" / "DDD" / "define terms" → `skills/deft-directive-glossary/SKILL.md` — extracts a DDD-style ubiquitous language from the current conversation, flags ambiguities and synonyms, proposes a canonical glossary, and writes `UBIQUITOUS_LANGUAGE.md`; integrates with `core/glossary.md` as a baseline when present (#441)
- "improve architecture" / "deep modules" / "interface design" / "refactor RFC" → `skills/deft-directive-gh-arch/SKILL.md` — explores codebase for shallow modules, designs competing interfaces in parallel via sub-agents, files a refactor RFC as a GitHub Issue (#442 re-land)
- "triage hygiene" / "work the cache" → `skills/deft-directive-triage/SKILL.md`
- "what's next" / "queue" / "build a cohort" → `skills/deft-directive-triage/SKILL.md`
- "welcome" / "onboard triage" → invokes `task triage:welcome` (N3 / #1143)

## Development Process (always follow)

### Implementation Intent Gate (#810)

- ! Run `task vbrief:preflight -- <path>` before any code-writing tool call or `start_agent` dispatch -- the gate exits 0 only when the candidate vBRIEF lives in `vbrief/active/` AND `plan.status == "running"`. The Taskfile target wraps `scripts/preflight_implementation.py` so the same invocation works whether deft is the project root or installed as a `deft/` subdirectory. The ONLY supported way to satisfy a non-zero exit is `task vbrief:activate <path>` (idempotent).
- ! Require an explicit action-verb directive (`build`, `implement`, `ship`, `swarm`, `run agents`, `start agent`) from the user before invoking the preflight gate or `start_agent` for implementation. When intent is ambiguous, ask one targeted question instead of inferring.
- ⊗ Infer implementation intent from lifecycle vocabulary ("do the full PR process", "start the work", "poller agents"), branching language, or workflow shape. Workflow-shape vocabulary is NOT authorization to spawn an implementation agent.
- ⊗ Treat affirmative continuation phrases (`yes`, `go`, `proceed`, `do it`) as implementation authorization unless the prior turn explicitly proposed implementation. Broad approval is not a substitute for an explicit action-verb directive.

**Pre-`start_agent` gate stack (#1149):** Before dispatching an implementation sub-agent via `start_agent`, run the gates in the canonical order: (1) vBRIEF implementation-intent gate (#810, `task vbrief:preflight -- <path>`) → (2) `task verify:cache-fresh` (D5 / #1127) → (3) branch-policy gate (existing -- `scripts/preflight_branch.py`, surfaced via `task verify:branch` and the `.githooks/pre-commit` / `pre-push` hooks; see `**Branching:**` below) → (4) `start_agent`. Any non-zero exit aborts dispatch; do NOT spawn the sub-agent past a failed gate. The canonical order makes the four gates composable so each one assumes the previous one has already cleared.

**Before code changes:**
- ! Check `./vbrief/` lifecycle folders for existing scope vBRIEF coverage of the issue being fixed
- ! If no scope vBRIEF exists for the work, create one in `./vbrief/proposed/` before implementing
- ⊗ Begin editing files before checking scope vBRIEF coverage and creating a feature branch — even if the user says "yes" or "proceed"

! Before opening a PR, run `skills/deft-directive-pre-pr/SKILL.md` for an iterative quality loop.

**Before committing:**
- Run `task check` (validate + lint + test) — this is the pre-commit gate
- ! New source files (`scripts/`, `src/`, `cmd/`, `*.py`, `*.go`) MUST include corresponding test files in the same PR -- running existing tests alone is not sufficient for new code; forward coverage requires new tests that exercise the new code paths
- Add CHANGELOG.md entry under `[Unreleased]`
- Verify .github/PULL_REQUEST_TEMPLATE.md checklist items are satisfied

**Branching:**
- ! Always work on a feature branch — never commit directly to master/main unless the user explicitly instructs it or `PROJECT-DEFINITION.vbrief.json` has `plan.policy.allowDirectCommitsToMaster = true` (typed flag, #746). The legacy `Allow direct commits to master:` narrative key is recognised at read time with a deprecation warning; new writes go through the typed surface only.
- ! Three enforcement surfaces back this rule (#747): (1) `.githooks/pre-commit` and `.githooks/pre-push` hooks call `scripts/preflight_branch.py`; install via `task setup` (idempotent `git config core.hooksPath .githooks`); verify via `task verify:hooks-installed`. (2) `task verify:branch` is wired into the `task check` aggregate so any pre-commit run flags a default-branch commit. (3) The `branch-gate` GH Actions workflow (`.github/workflows/branch-gate.yml`) refuses PRs whose `head_ref` equals `base_ref`. Override paths: `task policy:allow-direct-commits -- --confirm` writes the typed flag with a capability-cost disclosure; `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1` is the emergency env-var bypass.

**Branch Policy Disclosure (session start):**
- ! When `plan.policy.allowDirectCommitsToMaster = true` on the active project's `vbrief/PROJECT-DEFINITION.vbrief.json`, the agent MUST surface the policy state at the start of any interactive session (alongside or after the Deft Directive alignment confirmation). Use the disclosure phrasing from `scripts/policy.py::disclosure_line` -- e.g. `[deft policy] Direct commits to the default branch are ENABLED (source: typed). Branch-protection policy is OFF.`
- ⊗ Begin a session that will commit/push without surfacing the policy state when `allowDirectCommitsToMaster=true` -- the user needs visibility that the gate is OFF for this project

**PR conventions:**
- ROADMAP.md updates happen at release time — batch-move merged issues to Completed during the CHANGELOG promotion commit
- Commit messages: `feat/fix/docs/chore` prefix, concise subject, bullet-point body
- When running a review cycle on a PR, follow `skills/deft-directive-review-cycle/SKILL.md`
- ! After squash merge, verify issues actually closed: `gh issue view <N> --json state --jq .state`. Squash merges can silently fail to process closing keywords (`Closes #N`). If still open, close manually with a comment referencing the merged PR (#167)

## CHANGELOG entry style (#1242)

**Why this rule exists:** GitHub release bodies are capped at 125,000 characters. The release pipeline (`scripts/release.py::_section_for_version`) auto-flows the promoted `CHANGELOG.md` `[<version>]` section into the GitHub release body, so a `[Unreleased]` section that accumulates engineering-log-style entries hard-caps the release. The 2026-05-19 v0.32.0 Phase 3 e2e rehearsal hit this -- `gh release create` exited HTTP 422 "body is too long (maximum is 125000 characters)" because ~22 Wave-2d entries had drifted into multi-paragraph implementation walkthroughs that summed to ~140K chars. This rule keeps the ceiling out of reach.

- ! CHANGELOG `[Unreleased]` and promoted-version entries MUST be brief release-notes (2-4 sentences, roughly 300-800 chars), not implementation detail.
- ! Each entry MUST reference its canonical PR / issue number(s); preserve `Closes #N` / `Refs #N` tails when rewriting.
- ! Each entry MUST describe the user-visible change in plain English (not the conventional-commit subject, not the internal change name).
- ⊗ MUST NOT inline file paths, file lists, test counts, schema fragments, function signatures, or implementation walkthroughs in CHANGELOG entries -- they belong in the PR body.
- ⊗ MUST NOT exceed roughly 800 chars per entry. If the change genuinely needs more, split into multiple distinct user-visible bullets or move detail to the PR body and link it.
- ~ Lead with the user-visible benefit, then the mechanism, then the link. Mirrors the personal `ship-report` convention.

Canonical write-up + good / bad example: `CONTRIBUTING.md` `## CHANGELOG entry style (#1242)`. A deterministic-tier lint gate is a separate follow-up; v1 is prose-tier and enforced at code review on every PR touching `CHANGELOG.md`.

## Commands

- /deft:change <name>        — Propose a scoped change
- /deft:run:interview        — Structured spec interview
- /deft:run:speckit          — Five-phase spec workflow (large projects)
- /deft:run:discuss <topic>  — Feynman-style alignment
- /deft:run:research <topic> — Research before planning
- /deft:run:map              — Map an existing codebase
- run bootstrap              — CLI setup (terminal users)
- run spec                   — CLI spec generation

## PowerShell

**Root-cause rule (#798):** On Windows PowerShell 5.1, ANY modification of a file containing non-ASCII content MUST go through Python `pathlib.Path.read_text(encoding="utf-8")` / `write_text(text, encoding="utf-8")`. The corruption happens on the **READ** side: `Get-Content -Raw` decodes via the active Windows codepage (cp1252 or cp437) BEFORE any safe write can preserve the bytes. A correct UTF-8 write of already-corrupted text just persists the mojibake. PowerShell 7+ (`pwsh`), bash, and zsh handle UTF-8 correctly and are exempt.

- ! On PS 5.1, MUST use Python `pathlib` for all file edits touching non-ASCII glyphs (em dashes, arrows, ⊗, ✓, …, smart quotes, etc.) -- never `Get-Content -Raw` / `Set-Content` / inline `-replace` / backtick-n interpolation
- ! When writing files using PowerShell on PS 7+ where unavoidable, MUST use `New-Object System.Text.UTF8Encoding $false` -- never `[System.Text.Encoding]::UTF8` (writes BOM). See `scm/github.md` PS 5.1 section.
- ! Personal rule `3MieNBQjwlObZM1If060iy` on the user's Warp profile encodes the same prohibition for the swarm cohort -- this AGENTS.md rule is the project-side mirror so consumer-installed copies of deft carry the rule even when the personal rule is not loaded
- ⊗ Round-trip a file containing non-ASCII content through PS 5.1 commands (`Get-Content` → `-replace` → `Set-Content`, `Get-Content` → string concat → `WriteAllText`, here-strings interpolating non-ASCII) -- the read-side decode corrupts the bytes regardless of how the write side is encoded

**Recurrence record:** four prior occurrences before the deterministic gate landed -- #236 (t1.11.1, scm/github.md), #240 (t1.11.2, multi-line here-string rule), #283 (t1.20.1, AGENTS.md UTF8Encoding rule), and PR #795 (2026-05-01, 132-line CHANGELOG mojibake on a maintainer with all three prose rules loaded; the read-side decode happened before any write).

**Deterministic-tier enforcement (#798):** `scripts/verify_encoding.py` scans tracked text files for U+FFFD replacement chars, the curated CP1252/CP437-as-UTF-8 mojibake bigram set, and unexpected UTF-8 BOM on .md/.json/.yml/.yaml/.txt. Wired into `task check` via `task verify:encoding` and into `.githooks/pre-commit` via `--staged`. Three-state exit (0 clean / 1 corruption / 2 config error). Per `main.md` Rule Authority [AXIOM] this elevates the rule from prose tier to deterministic tier -- the gate is the rule body; this AGENTS.md section is a cross-reference, not a duplicate. Document an exception via `task verify:encoding -- --allow-list <path>` (newline-separated glob patterns).

## SCM tooling -- prefer ghx (#884)

**Why this rule exists:** the deft `scm:*` task surface (and the multi-agent swarm flows that consume it) make many read-only `gh` calls per session. Without a cache proxy, large swarms can saturate the unauthenticated `gh` rate limit (5,000 req/hr/user) within minutes -- the failure mode is silent stalls or 403s mid-cascade, not a clean error. `ghx` ([brunoborges/ghx](https://github.com/brunoborges/ghx)) is a drop-in caching proxy for `gh` that coalesces concurrent identical requests and serves cached read-only responses; v0.26.0 `scripts/scm.py` already prefers `ghx` over `gh` at runtime via the `_BINARY_PREFERENCE` ladder when `ghx` is on PATH (see `scripts/scm.py::resolve_binary`).

- ! When you need to invoke the GitHub CLI (`gh issue view`, `gh pr list`, `gh api`, ...) and `ghx` is on PATH, prefer `ghx` over `gh` -- the surface is identical and the cached responses are 10x faster on repeated calls
- ! Fall back to `gh` transparently when `ghx` is not on PATH; do NOT fail or warn -- this mirrors the `scripts/scm.py` runtime ladder and keeps the rule additive for consumers who have not yet opted in
- ~ Maintainers SHOULD run `task setup` (which invokes `scripts/setup_ghx.py`) to install `ghx`; the install is consent-gated and never auto-runs by default. Pass `--yes` for non-interactive (CI / scripted) approval
- ⊗ Auto-install `ghx` without explicit operator consent -- `task setup` MUST prompt before invoking the upstream installer; the only non-interactive paths are `--yes` (explicit approval) or `DEFT_SETUP_GHX_SKIP=1` (explicit opt-out)
- ! Raw `gh` calls outside `scripts/scm.py` are forbidden by `task verify:scm-boundary` (#1145 / N5 -- partial down-payment on #445 / #935 Workstream 6). The verb layer (`scripts/triage_*.py`, `scripts/scope_*.py`, `scripts/slice_*.py`, `scripts/issue_ingest.py`, ...) MUST invoke `gh` only via `scm.call(source, verb, args, **kwargs)`; the deterministic gate scans the canonical scope globs and fails `task check` when any of them route around the shim. Non-`github-issue` sources raise `NotImplementedError` so a consumer on GitLab / Gitea / local sees the deferred abstraction immediately.
- ? Power users MAY install `ghx` manually via the upstream `install.ps1` (Windows) or `install.sh` (macOS / Linux); the `task setup` prompt is a convenience, not a gate

## Test performance discipline (#975)

**Why this rule exists:** the 2026-05-08 triage-suite profile (`pytest tests/ -k triage --durations=20`) found that 5 watchdog regression tests in `tests/integration/test_triage_bootstrap_at_scale.py` plus one in `tests/test_triage_bootstrap.py` accounted for ~68% of the triage-suite wall-clock (~5.85s out of ~8.54s). The watchdog tests assert real `time.sleep` / thread-join behaviour from #952 and so necessarily burn small amounts of wall-clock; without a marker convention they show up in every `task check` run on every iteration of every PR. Issue #975 introduced the `slow` pytest marker convention as a stop-gap (the proper fix is a monkeypatch-based clock injection, tracked as a follow-up to #975). This rule codifies the convention so future agents apply the marker (or refactor) when they encounter a similarly slow test, rather than re-discovering the friction.

- ! When a single test exceeds ~1s wall-clock, mark it with `@pytest.mark.slow` or refactor it to use injected clocks / `monkeypatch` so it runs in milliseconds. The marker is registered in `pyproject.toml` `[tool.pytest.ini_options]` and the `addopts = "-m 'not slow'"` default excludes marked tests from `task check` -- the slow lane is run explicitly via `task check:slow`. See `CONTRIBUTING.md` `### Slow tests (#975)` for the contributor surface.
- ! When profiling a suite that feels slow, run `pytest <file> --durations=20` (or the equivalent task invocation) to see the top wall-clock offenders. Any single test exceeding 1s MUST be marked `@pytest.mark.slow` or refactored before merging.
- ~ Run `task check:slow` locally before pushing changes that touch any `@pytest.mark.slow` test (or the watchdog / threading code those tests cover). The default `task check` skips the slow lane; CI runs both.
- ~ Treat `@pytest.mark.slow` as a stop-gap, not a destination. Long-term, slow tests SHOULD be refactored to remove the wall-clock dependency (e.g. inject a fake clock, swap `time.sleep` for `monkeypatch`, use `threading.Event` instead of polling). The marker buys breathing room while the proper refactor lands.
- ⊗ Add `@pytest.mark.slow` to tests that are fast but flaky -- the marker is for genuine wall-clock cost, not for hiding intermittent failures. Flaky tests must be fixed at the root cause, not hidden behind the slow lane.

Cross-references: `pyproject.toml` (marker registration + default opt-out), `Taskfile.yml` `check:slow` (slow lane), `CONTRIBUTING.md` `### Slow tests (#975)` (contributor convention), `tests/integration/test_triage_bootstrap_at_scale.py` + `tests/test_triage_bootstrap.py` (current marker users).

## Multi-agent orchestration discipline (#954)

**Why this rule exists:** the 2026-05-07 multi-agent session surfaced concrete recurrence patterns when orchestrators dispatched workers without a canonical preamble — workers polled GitHub via GraphQL surfaces (`gh pr view --json`, `gh pr ready`) and exhausted the 5000-req/hr GraphQL bucket mid-cascade; release agents looped on Draft↔Ready toggles burning more GraphQL budget; one worker self-terminated with `succeeded` lifecycle while reporting "holding for reply" in a status message, breaking the implied resume channel. The canonical preamble at `templates/agent-prompt-preamble.md` and the rules below institutionalise the mitigations. Consumer-installed deft carries this rule even when the orchestrator does not load it, so swarm cohorts inherit the discipline.

- ! When invoking `gh` for read-only operations, prefer REST surfaces over GraphQL -- forbid `gh issue view --json`, `gh pr view --json`, `gh pr ready`, `gh pr update-branch` (all GraphQL); use `gh api repos/<owner>/<repo>/issues/<N>` / `gh api repos/<owner>/<repo>/pulls/<N>` (REST) or `ghx api` (cached REST) instead. The GraphQL bucket is shared across all workers under the same identity and is the operational bottleneck, not the REST `core` bucket.
- ! Within a single review cycle, toggle PR Draft↔Ready state at most once. Once Ready, stay Ready unless a P0 finding demands a re-Draft -- each toggle costs a GraphQL mutation and stale Draft re-toggles are the documented failure mode for the PR #652-class merge cascades.
- ! Before any GraphQL-heavy operation (PR readiness check, review polling, batch issue ingest, mass `gh pr list`), probe `gh api rate_limit` (the live, uncached form) and inspect `graphql.remaining`. If < 500, switch to REST equivalents or batch+wait until the bucket resets. The decision tree lives in `templates/agent-prompt-preamble.md` § 7. Do NOT use `ghx api rate_limit` for the throttle probe -- ghx is a cached read-only GET proxy, so the cached value can be stale; under N-concurrent-workers the GraphQL bucket can deplete within minutes between probe and use, causing an agent to proceed into GraphQL-heavy work against an exhausted bucket.
- ! Dispatcher-level lifecycle hygiene: workers MUST be all-or-nothing on their dispatch envelope. Mid-scope user-approval gates require two separate dispatches (Scope A → worker reports back → user approves → Scope B). A worker that finishes its tool loop while emitting a "paused, awaiting reply" status message will be observed as `succeeded` (terminal) by the platform; its `agent_id` then becomes unreachable and reply messages have no live runtime to deliver to. Splitting at the gate is the only enforceable mitigation. See `templates/agent-prompt-preamble.md` § 9.
- ! Orchestrators dispatching implementation sub-agents MUST include the canonical preamble verbatim (or by reference) in the worker's dispatch envelope -- see `templates/agent-prompt-preamble.md`. The preamble covers AGENTS.md read mandate, the #810 vBRIEF gate walkthrough, the PowerShell 5.1 non-ASCII rule (#798), pre-pr + review-cycle skill mandates, the four rules above, sub-agent spawn rules per #727, and the mandatory DONE message protocol.
- ⊗ Dispatch an implementation sub-agent without including the canonical preamble (or a reference to `templates/agent-prompt-preamble.md` it can read directly) -- the recurrence patterns above re-fire on every fresh dispatch that omits this institutional memory.

**ghx surface clarification (#954):** `ghx` is a cached read-only GET proxy for `gh`, NOT a full drop-in passthrough. The `ghx api` subcommand accepts a single positional path arg only -- multi-arg forms (e.g. `ghx api -X POST repos/.../comments --input file.json`) fail with `accepts 1 arg(s), received N`. Writes (POST/PATCH/PUT/DELETE via `gh api -X ...`) MUST fall through to `gh` directly. ghx wins for cached read-only `GET`s; `gh` owns mutations and any flag-rich `api` invocation. The `scripts/scm.py::resolve_binary` ladder already encodes this distinction at runtime; this clarification mirrors it for human readers.

## Umbrella current-shape convention (#1152)

**Why this rule exists:** the #1140 design-pass-churn deep-think analysis surfaced failure mode F3 -- an umbrella issue authored on pass-1 and amended via N comments forces every fresh contributor on pass-N to reconstruct the current shape by reading the umbrella body plus N amendment comments in order. That reconstruction cost compounds with every pass; the #1119 umbrella's 4-pass inflation (4 -> 8 -> 11 -> 16 children) only became visible at pass-4 because no canonical current-shape surface existed at pass-3. The convention below collapses the reconstruction cost to one comment read for every fresh contributor on every umbrella, forever. Each umbrella carries exactly ONE canonical comment titled `## Current shape (as of pass-N)`, edited in place at the end of every design pass. Amendment comments remain as the audit trail (they are never removed); the canonical "what does the umbrella look like right now?" surface is the single edited-in-place comment.

- ! Every umbrella issue MUST have a single canonical `## Current shape (as of pass-N)` comment, edited in place after each design pass.
- ! The current-shape comment MUST list open children, closed children, wave order, and the child-count history.
- ~ Pass-N skills SHOULD update the current-shape comment as their Phase 4 step.
- ⊗ Do NOT delete prior amendment comments when updating the current-shape comment — they remain the audit trail.
- ⊗ Do NOT replace the current-shape comment with a fresh comment — it must be edited in place so its permalink is stable.

**Canonical body structure:** the current-shape comment body MUST carry the following sections in the order listed so any fresh contributor can scan the same skeleton across every umbrella:

1. `Last updated:` -- ISO-8601 UTC timestamp of the most recent edit-in-place.
2. `Last pass type:` -- one of `additive | subtractive | refactor | verify` (per the pass-type declaration counterpart, N14 / TBD).
3. `Child count:` -- `<total> (<open>/<closed>)`.
4. `Child-count history:` -- `pass-1: N1, pass-2: N2, ...` so inflation / deflation across passes is visible at a glance.
5. `### Open children` -- list with brief role-tag per child.
6. `### Closed children` -- list with closure reason per child.
7. `### Wave order` -- dependency graph or wave-grouped list.
8. `### Open questions` -- optional; surface decisions still owing operator input.
9. `### Reading order for fresh contributors` -- the canonical three-step (umbrella body -> this comment -> amendment comments) so a new reader knows where to start.

v1 ships as discipline-only (this AGENTS.md section + skill cross-references in `skills/deft-directive-gh-slice/SKILL.md` and `skills/deft-directive-refinement/SKILL.md` final phases). The optional mechanical render verb (`task umbrella:current-shape <N>`) is deferred to v2 unless discipline degrades; the v2 mechanical render requires a structured-amendment-comment format which chains cleanly off the N14 (TBD) pass-type declaration rule.

Cross-references: `skills/deft-directive-gh-slice/SKILL.md` (final phase -- file the umbrella, then file its current-shape comment per this convention), `skills/deft-directive-refinement/SKILL.md` (final phase -- same cross-reference), `templates/agent-prompt-preamble.md` (canonical orchestrator preamble that consumers of this convention dispatch against). Refs #1140 (parent meta-umbrella -- design-pass churn), #1119 (companion umbrella whose pattern motivated this convention; its v3 current-shape comment is the seed example pre-dating this convention).

Note: paths here are root-relative — this repo IS the deft directory.
Install-generated AGENTS.md uses deft/-prefixed paths.
