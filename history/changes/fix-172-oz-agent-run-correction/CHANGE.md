# Change: fix-172-oz-agent-run-correction

**Issue:** #172
**Branch:** fix/172-oz-agent-run-correction
**Status:** completed

## Problem

`skills/deft-swarm/SKILL.md` Phase 3 incorrectly states that `oz agent run` launches
cloud agents on remote VMs. Warp confirmed: `oz agent run` is **local** (runs on the
user's machine with codebase indexing, Warp Drive rules, `--profile`, `--mcp`).
`oz agent run-cloud` is the cloud path.

This false premise inverted the preferred launch strategy and propagated into
`meta/lessons.md` (lessons #1 and #7) and `SPECIFICATION.md` (t2.5.4).

## Changes

- `skills/deft-swarm/SKILL.md` — Phase 3 rewrite: `oz agent run` = preferred automated
  local path; manual Warp tabs = interactive alternative; `oz agent run-cloud` = cloud.
  Fix prerequisites, option labels, anti-patterns throughout.
- `meta/lessons.md` — Lesson #1: add correction addendum. Lesson #7: clarify agents
  were local, stop-after-PR was a prompt issue not a cloud limitation.
- `SPECIFICATION.md` — t2.5.4: update acceptance criteria to reflect corrected launch
  preference order.

## Acceptance Criteria

- Phase 3 correctly identifies `oz agent run` as local execution
- `oz agent run-cloud` is documented as the cloud path
- Lessons #1 and #7 have correction addenda (original text preserved for history)
- t2.5.4 acceptance criteria no longer says "Warp tabs preferred, oz agent run fallback"
- `task check` passes
