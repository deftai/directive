# AGENTS.md incident-rule rationale archive (#2156)

Moved from `AGENTS.md` maintainer narrative blocks (`Why this rule exists`, `Recurrence record`, long `Cross-references`) during the #1882 Wave-2 rationale collapse (#2156). **Enforcement is unchanged** — the gates, helpers, and `!` / `⊗` / `~` directives remain in `AGENTS.md`; this file holds the history only.

## CHANGELOG entry style (#1242)

**Why this rule exists:** GitHub release bodies are capped at 125,000 characters. The release pipeline (`scripts/release.py::_section_for_version`) auto-flows the promoted `CHANGELOG.md` `[<version>]` section into the GitHub release body, so a `[Unreleased]` section that accumulates engineering-log-style entries hard-caps the release. The 2026-05-19 v0.32.0 Phase 3 e2e rehearsal hit this -- `gh release create` exited HTTP 422 "body is too long (maximum is 125000 characters)" because ~22 Wave-2d entries had drifted into multi-paragraph implementation walkthroughs that summed to ~140K chars. This rule keeps the ceiling out of reach.

Canonical write-up + good / bad example: `CONTRIBUTING.md` `## CHANGELOG entry style (#1242)`. A deterministic-tier lint gate is a separate follow-up; v1 is prose-tier and enforced at code review on every PR touching `CHANGELOG.md`.

## PowerShell encoding (#798)

**Root-cause rule:** On Windows PowerShell 5.1, ANY modification of a file containing non-ASCII content MUST go through Python `pathlib.Path.read_text(encoding="utf-8")` / `write_text(text, encoding="utf-8")`. The corruption happens on the **READ** side: `Get-Content -Raw` decodes via the active Windows codepage (cp1252 or cp437) BEFORE any safe write can preserve the bytes. A correct UTF-8 write of already-corrupted text just persists the mojibake. PowerShell 7+ (`pwsh`), bash, and zsh handle UTF-8 correctly and are exempt.

**Recurrence record:** four prior occurrences before the deterministic gate landed -- #236 (t1.11.1, content/scm/github.md), #240 (t1.11.2, multi-line here-string rule), #283 (t1.20.1, AGENTS.md UTF8Encoding rule), and PR #795 (2026-05-01, 132-line CHANGELOG mojibake on a maintainer with all three prose rules loaded; the read-side decode happened before any write).

**Deterministic-tier enforcement:** `scripts/verify_encoding.py` scans tracked text files for U+FFFD replacement chars, the curated CP1252/CP437-as-UTF-8 mojibake bigram set, and unexpected UTF-8 BOM on .md/.json/.yml/.yaml/.txt. Wired into `task check` via `task verify:encoding` and into `.githooks/pre-commit` via `--staged`. Three-state exit (0 clean / 1 corruption / 2 config error). Per `main.md` Rule Authority [AXIOM] this elevates the rule from prose tier to deterministic tier -- the gate is the rule body; the AGENTS.md section is a cross-reference, not a duplicate. Document an exception via `task verify:encoding -- --allow-list <path>` (newline-separated glob patterns).

## Grok Build Windows capture (#1353)

See also: `docs/analysis/2026-05-26-issue-1353-grok-windows-capture-opensrc-audit.md` (root-cause analysis). Refs #1353.

**Why this rule exists:** When running under the Grok Build runtime on Windows + pwsh 7+, `run_terminal_command` leaks internal wrapper text (Get-Content and redirection fragments) whenever the command string contains `|`, `2>&1`, `| cat`, `>`, or similar metacharacters. Non-piped commands execute cleanly.

## Safe subprocess capture (#1366)

**Why this rule exists:** the 2026-05-26 #1166 swarm session repeatedly hit `Thread-3 (_readerthread) UnicodeDecodeError` from inside Python's `subprocess.run(..., capture_output=True, text=True)` whenever a tool (most often `scripts/pr_merge_readiness.py`) captured `gh api` output containing a Greptile rolling-summary body. The default `text=True` decode path uses the host codepage (cp1252 / cp437 on Windows), and Greptile bodies routinely carry glyphs (em dashes, smart quotes, arrows) that the codepage cannot decode. Once the reader thread crashes, the script returns empty / malformed stdout and any dependent monitor sees `head: None`. The structural fix is to force `encoding="utf-8", errors="replace"` on every text-capturing subprocess call so undecodable bytes become U+FFFD instead of crashing the read.

**Recurrence record:** observed across multiple gh-shelling scripts during the #1166 swarm (`pr_merge_readiness.py`, `tmp_monitor_1363.py`, ad-hoc monitor scripts). The class of bug also bit prior PowerShell-encoding work (#236 / #240 / #283 / #795) on the file-edit side; the subprocess-capture side is the structural complement covered by #1366.

**Cross-references:** `content/templates/agent-prompt-preamble.md` § 3.6, `docs/analysis/2026-05-26-issue-1353-grok-windows-capture-opensrc-audit.md` (related #1353 wrapper-leakage analysis), Wave-2 dependents #1365 (sub-agent visibility) and #1368 (`pr_merge_readiness.py` hardening), Wave-3 dependent #1369 (cascade automation).

## Cascade automation surface (#1369)

**Why this rule exists:** the 2026-05-26 #1166 swarm cascade saw the monitor babysit individual PRs because there was no first-class "wait-until-ready, then merge" primitive that survived the Grok Build harness fragility documented at #1353 / #1366. The Wave-1+2 work made the underlying primitives reliable (`_safe_subprocess.run_text` #1366, `pr_merge_readiness.py` layered fallbacks #1368, `monitor_pr.py` resilient wait loop #1368) and the Wave-3 helper `scripts/pr_wait_mergeable.py` composes them into one verb. The cascade now has a deterministic three-state exit (0 merged / 1 timeout-or-escalation / 2 config error); the protected-issue inspector chains AHEAD of the wait loop so a Layer-3 false-positive (#701) cannot reach a `gh pr merge` call.

**Recurrence record:** the #1166 swarm cascade abandoned automated merging on PR #1363 + Wave 3 because the existing hand-rolled monitor (which pre-dated #1368 / #1366) went blind on `pr_merge_readiness.py` exits where `head: None` survived for 15+ minutes. The cascade automation surface (#1369) is the structural answer; the rule above keeps the surface load-bearing instead of an opt-in convenience that drifts back into hand-rolled loops on future swarms.

**Cross-references:** `scripts/pr_wait_mergeable.py` (helper), `tasks/pr.yml` `wait-mergeable-and-merge` (Taskfile surface), `tests/cli/test_pr_wait_mergeable.py` (acceptance contract), `content/skills/deft-directive-swarm/SKILL.md` Phase 6 Step 1 + Phase 6 Step 5 (cascade automation citations), `scripts/monitor_pr.py` + `scripts/pr_merge_readiness.py` (Wave-2 wait-until-ready primitives, #1368), `scripts/pr_check_protected_issues.py` (Layer-3 #701).

## Headless swarm launch gate-stack (#1387)

**Why this rule exists:** launching a swarm has historically required walking the full interactive Phase 0 (queue scan, promote-fill loop, lifecycle bridge, allocation approval) even when the operator already has a curated, pre-approved cohort in hand. The headless / low-ceremony launch path (#1387, built on the #1378 allocation-context token) collapses those per-phase gates into a single consent so a ready cohort launches in one shot. This gate-stack note is the maintainer-side mirror of `content/skills/deft-directive-swarm/SKILL.md`; both surfaces MUST agree (it is swarm-orchestration discipline, maintainer-only, like #954 / #1364 / #1369 -- not part of the consumer managed-section).

**Cross-references:** `content/skills/deft-directive-swarm/SKILL.md` Phase 0 (headless cohort fast-path), Phase 2 Step 1 Mode A (pre-created worktree map), Phase 3 Step 0.5 (launch-manifest consumption); `content/templates/agent-prompt-preamble.md` § 2.5 (the #1378 allocation-context token). Refs #1387, #1378.

## SCM tooling — prefer ghx (#884)

**Why this rule exists:** the deft `scm:*` task surface (and the multi-agent swarm flows that consume it) make many read-only `gh` calls per session. Without a cache proxy, large swarms can saturate the unauthenticated `gh` rate limit (5,000 req/hr/user) within minutes -- the failure mode is silent stalls or 403s mid-cascade, not a clean error. `ghx` ([brunoborges/ghx](https://github.com/brunoborges/ghx)) is a drop-in caching proxy for `gh` that coalesces concurrent identical requests and serves cached read-only responses; v0.26.0 `scripts/scm.py` already prefers `ghx` over `gh` at runtime via the `_BINARY_PREFERENCE` ladder when `ghx` is on PATH (see `scripts/scm.py::resolve_binary`).

## Test performance discipline (#975)

**Why this rule exists:** the 2026-05-08 triage-suite profile (`pytest tests/ -k triage --durations=20`) found that 5 watchdog regression tests in `tests/integration/test_triage_bootstrap_at_scale.py` plus one in `tests/test_triage_bootstrap.py` accounted for ~68% of the triage-suite wall-clock (~5.85s out of ~8.54s). The watchdog tests assert real `time.sleep` / thread-join behaviour from #952 and so necessarily burn small amounts of wall-clock; without a marker convention they show up in every `task check` run on every iteration of every PR. Issue #975 introduced the `slow` pytest marker convention as a stop-gap (the proper fix is a monkeypatch-based clock injection, tracked as a follow-up to #975). This rule codifies the convention so future agents apply the marker (or refactor) when they encounter a similarly slow test, rather than re-discovering the friction.

**Cross-references:** `pyproject.toml` (marker registration + default opt-out), `Taskfile.yml` `check:slow` (slow lane), `CONTRIBUTING.md` `### Slow tests (#975)` (contributor convention), `tests/integration/test_triage_bootstrap_at_scale.py` + `tests/test_triage_bootstrap.py` (current marker users).

## Multi-agent orchestration discipline (#954)

**Why this rule exists:** the 2026-05-07 multi-agent session surfaced concrete recurrence patterns when orchestrators dispatched workers without a canonical preamble — workers polled GitHub via GraphQL surfaces (`gh pr view --json`, `gh pr ready`) and exhausted the 5000-req/hr GraphQL bucket mid-cascade; release agents looped on Draft↔Ready toggles burning more GraphQL budget; one worker self-terminated with `succeeded` lifecycle while reporting "holding for reply" in a status message, breaking the implied resume channel. The canonical preamble at `content/templates/agent-prompt-preamble.md` and the rules below institutionalise the mitigations. Consumer-installed deft carries this rule even when the orchestrator does not load it, so swarm cohorts inherit the discipline.

**Orchestrator dispatch doctrine (#1880):** Root cause from the 2026-06-22 #1878 session (Gaps C and D). Canonical prose lives in `content/templates/agent-prompt-preamble.md` §9; skills cross-reference swarm Phase 3/5→6 and review-cycle Review Monitoring.

**ghx surface clarification (#954):** `ghx` is a cached read-only GET proxy for `gh`, NOT a full drop-in passthrough. The `ghx api` subcommand accepts a single positional path arg only -- multi-arg forms (e.g. `ghx api -X POST repos/.../comments --input file.json`) fail with `accepts 1 arg(s), received N`. Writes (POST/PATCH/PUT/DELETE via `gh api -X ...`) MUST fall through to `gh` directly. ghx wins for cached read-only `GET`s; `gh` owns mutations and any flag-rich `api` invocation. The `scripts/scm.py::resolve_binary` ladder already encodes this distinction at runtime; this clarification mirrors it for human readers.

## Umbrella current-shape convention (#1152)

**Why this rule exists:** the #1140 design-pass-churn deep-think analysis surfaced failure mode F3 -- an umbrella issue authored on pass-1 and amended via N comments forces every fresh contributor on pass-N to reconstruct the current shape by reading the umbrella body plus N amendment comments in order. That reconstruction cost compounds with every pass; the #1119 umbrella's 4-pass inflation (4 -> 8 -> 11 -> 16 children) only became visible at pass-4 because no canonical current-shape surface existed at pass-3. The convention below collapses the reconstruction cost to one comment read for every fresh contributor on every umbrella, forever. Each umbrella carries exactly ONE canonical comment titled `## Current shape (as of pass-N)`, edited in place at the end of every design pass. Amendment comments remain as the audit trail (they are never removed); the canonical "what does the umbrella look like right now?" surface is the single edited-in-place comment.

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

v1 ships the read/render-and-validate command `task umbrella:current-shape <N>` (native deft-ts verb, #2066): it fetches `repos/<owner>/<repo>/issues/<N>/comments` via the scm shim, locates the canonical `## Current shape (as of pass-N)` comment, prints it (or `--json` with section validation), and exits non-zero when no current-shape comment exists — it never falls back to the issue body. `--strict` MAY exit non-zero on missing required #1152 sections. A future v2 MAY add structured-amendment-comment parsing (N14 / TBD pass-type declaration) for richer mechanical renders.

**Cross-references:** `content/skills/deft-directive-gh-slice/SKILL.md` (final phase -- file the umbrella, then file its current-shape comment per this convention), `content/skills/deft-directive-refinement/SKILL.md` and `content/skills/deft-directive-triage/SKILL.md` (before reporting umbrella status, read the current-shape comment + linked xBRIEF, not the body), `content/templates/agent-prompt-preamble.md` (canonical orchestrator preamble that consumers of this convention dispatch against). Refs #1140 (parent meta-umbrella -- design-pass churn), #1119 (companion umbrella whose pattern motivated this convention; its v3 current-shape comment is the seed example pre-dating this convention), #2066 (claim-cites-state-surface -- forbid body-only status conclusions).

## Issue body→comments reading (#2143)

**Why this rule exists:** the #2126 dispatch recurrence built a worker envelope from the issue body only; a maintainer comment on the same issue had already invalidated the body's suggested fix and named the correct approach. The umbrella current-shape convention (#1152) encodes the same principle for umbrellas — body is pass-1, comments supersede — but that discipline was not generalized to ordinary issues or enforced at ingest time.

**Cross-references:** `content/templates/agent-prompt-preamble.md` § 5.6, issue #2143. Refs #1152, #2066, #2126.
