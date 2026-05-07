# #883 Overnight R-C Chain — Stacked PRs, Self-Perpetuating Monitor
Archived from Warp plan `f9030aca-2804-4b64-9eb1-097eee53a37c` on 2026-05-06.
Resolved open questions:
1. Activation chore-PR: SKIP. Each wave's worker calls `task vbrief:activate` on its own branch as the first commit; activation rides along with implementation PR.
2. PR drafting: open all 4 PRs as Drafts.
3. Failure notification: silent halt; maintainer checks in at keyboard.
4. Release dispatch: deferred to maintainer post-Wave-4-merge; Wave 4 worker does NOT invoke `task release`.
## Problem
Ship the four #883 v1 cache-quarantine stories overnight as stacked PRs (R-C). Stories are linearly dependent: Story 2 calls Story 1's `scm:*`; Story 3 calls Story 2's `cache:*`; Story 4 documents Stories 1-3 + dispatches release. Maintainer keeps merge authority; chain runs unattended; failures halt the chain and wait for morning.
## Current State (at kickoff)
- Master at `350ee7f` (#938 + #939 merged); worktree clean.
- 5 #883 vBRIEFs in `vbrief/pending/` (epic + 4 stories). None in `vbrief/active/`.
- Branch protection requires human merge (no auto-merge).
- Story 1 vBRIEF carries the contract-test AC (#939) — `tests/fixtures/scm_issue_view.json` is the cross-wave handoff artifact.
## Chain Shape (R-C stacked PRs)
Wave N branches from Wave (N-1)'s branch; PRs all target `master`. Each wave runs in its own git worktree.
Worktree layout: `C:\Repos\deft-883-w1` … `C:\Repos\deft-883-w4`. Branches per `metadata.x-tracking.branch` in each story vBRIEF: `feat/883-story-N-<slug>`.
Wave dependency: Wave 2 worktree branches from `feat/883-story-1-scm-stub`; Wave 3 from `feat/883-story-2-cache-infrastructure`; Wave 4 from `feat/883-story-3-triage-rebind`.
## Topology
- Local agents only (24/7 machine).
- Per-wave shape: ONE agent per wave. Owns implement → pre-pr → push → PR open (Draft) → review-cycle (Greptile fix loop) → READY-TO-MERGE state. Does NOT merge.
- Monitor: dispatches Wave N, watches lifecycle + status, rebases stacked branches if upstream wave's PR receives review-cycle commits, escalates on caps. Self-perpetuating: hands off to successor at ~70% context or after each wave boundary.
- Worker message protocol: messages only at (a) start, (b) blocked/failed, (c) done.
## Caps & Halt Rules
- Review-cycle iterations: 3 max per wave. 4th → BLOCKED.
- Wall-clock per wave: 2.5h. → BLOCKED.
- Lifecycle: any failed/blocked/errored → halt subsequent waves. No user wakeup.
- Greptile-errored: retry once via `@greptileai review`; if still errored, halt the wave (no autonomous override).
## Per-Wave Watch-List (monitor enforcement)
After each wave's PR opens, monitor verifies the diff against the vBRIEF's `files_owned`/`files_must_not_touch`. Halt on violation.
**Wave 1 (Story 1).** Halt if PR diff touches `scripts/cache.py`, `scripts/cache_scanner.py`, `tasks/cache.yml`, `vbrief/schemas/cache-meta.schema.json`, any `scripts/triage_*.py`, `skills/deft-directive-refinement/SKILL.md`, or `UPGRADING.md`. Halt if `tests/fixtures/scm_issue_view.json` missing or contract test missing. Halt if forward-compat marker comment missing from `tasks/scm.yml`.
**Wave 2 (Story 2).** Halt if PR diff touches `tasks/scm.yml`, any `triage_*.py`, refinement skill, or UPGRADING.md. Halt if `vbrief/schemas/cache-meta.schema.json` shape diverges from epic narrative (source/key/fetched_at/ttl_seconds/expires_at/scan_result/size_bytes/stale). Halt if scanner severity isn't per-category (injection=fence-and-pass, credentials=hard-fail, invisible-unicode=strip-and-pass). Halt if `cache:fetch-all` lacks `--batch-size`/`--delay-ms`/429-retry. Halt if `tests/fixtures/scm_issue_view.json` modified.
**Wave 3 (Story 3).** Halt if diff adds `triage:cache:*` or `triage:show:*` (must DELETE not refactor). Halt if `scripts/triage_cache.py` or `tasks/triage-cache.yml` still present. Halt if any kept `triage:*` task's external CLI surface changed. Halt if refinement skill Phase 0 doesn't reference `cache:*`. Halt if `triage_bootstrap.py` doesn't orchestrate `cache:fetch-all` + audit init + gitignore-ensure.
**Wave 4 (Story 4).** Halt if CHANGELOG v0.26.0 entry under `### Added` (must lead `### Breaking`). Halt if UPGRADING.md section breaks the four-field micro-format. Release dispatch step (acceptance #6) DEFERRED to maintainer.
## Monitor Handoff
Trigger: ~70% context OR after each wave boundary, whichever first. Each successor receives: master HEAD SHA + last-merged PR; active wave + worker agent_id; open PRs and last-known status; watch-list verbatim; caps + halt rules verbatim; worktree paths + branch names; last 5 lifecycle events per agent.
## Morning-After (maintainer)
1. Inspect Wave 1 draft PR; ready it; merge `--squash --delete-branch`.
2. Inspect Wave 2 draft (auto-rebased); ready; merge.
3. Repeat for Waves 3, 4.
4. Post-Wave-4-merge: invoke `skills/deft-directive-release/SKILL.md` for v0.26.0.
5. Lifecycle-move epic + 4 stories from `active/` to `completed/`.
