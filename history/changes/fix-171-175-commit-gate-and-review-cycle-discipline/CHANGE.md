# Change: fix-171-175-commit-gate-and-review-cycle-discipline

**Issues:** #171, #175
**Branch:** fix/171-175-commit-gate-review-discipline
**Status:** completed

## Problem

**#171:** An agent committed and pushed directly to `master` during #166 work. No explicit
framework rule prohibited it. Solo developers may legitimately use trunk-based workflow,
so the rule needs a `PROJECT.md` override mechanism rather than a blanket prohibition.

**#175:** During PR #173 review cycle, commits were pushed while Greptile was still
reviewing a previous commit (re-triggering Greptile). No poll cadence guidance existed,
causing agents to spam `get_check_runs` calls seconds apart.

## Changes

- `main.md` — `⊗` direct-to-master rule with PROJECT.md `Allow direct commits to master`
  override escape hatch
- `AGENTS.md` — explicit branch gate note in Development Process
- `skills/deft-build/SKILL.md` — anti-pattern: no direct-to-master commits
- `skills/deft-review-cycle/SKILL.md` — Phase 1: verify feature branch; Step 4: `⊗`
  no-push-while-reviewing + `~` 60s minimum poll interval
- `templates/project.md.template` — optional `## Branching` section with commented flag
- `skills/deft-setup/SKILL.md` — Phase 2 Track 1: branching preference question + template
- `run` CLI (`cmd_project`) — branching prompt + emit flag if trunk-based
- `meta/lessons.md` — Review Cycle Monitoring #2 (no-push-mid-review) + #3 (60s cadence)

## Acceptance Criteria

- `main.md` `⊗` rule covers direct-to-master with PROJECT.md override
- `AGENTS.md` Development Process contains branch gate note
- `deft-build` anti-patterns contains direct-to-master prohibition
- `deft-review-cycle` Phase 1 verifies feature branch; Step 4 has no-push + poll cadence
- `templates/project.md.template` has commented `## Branching` section
- `deft-setup` Phase 2 Track 1 asks branching preference; template includes it
- `cmd_project` asks branching preference and emits flag if trunk-based
- `meta/lessons.md` Review Cycle Monitoring has #2 and #3
- `task check` passes including existing tests
