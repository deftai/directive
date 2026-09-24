# Scope provenance (`verify:scope-provenance`)

Refs: #3145 · #3205 · #4956 · Related: #1310, #2944 human-origin grants, #516 file scope · class checks: #4980 · generalizes under [gate-integrity.md](./gate-integrity.md) (#3156) · UI structure: [observable-scope.md](./observable-scope.md) (#4495)

## Problem

An implementation PR could edit its own active xBRIEF to add new paths, after which gates stayed green. The modified head brief became its own authorization source. Separately, operator proceed on a swarm cohort still stopped for leave-harness `scope:record-approved-scope` ("mint") per story (#4956).

## Contract (#4956)

**After proceed there is no scope ceremony to schedule.** Proceed writes nothing: no `.deft/approved-scope` record, no typed mint phrase, no `scope:record-approved-scope` for proceed or for a later path-list growth. `authz:grant` keeps the phrase `mint` (#3110).

### Fence = merge-base brief `file_scope`

The fence is the active brief's `plan.metadata.swarm.file_scope` **on the merge base**. That declaration is agent-authored precommitment. The fence is a drift check against that list, not a human authorization of the paths.

Two builds carry it:

1. **Merge-time check** (`verify:scope-provenance` / `task check`) compares **changed files** to the base brief. It does **not** read the head brief for the allow list. A PR that adds production paths and edits its own active brief to include them still fails.
2. **Write fence** reads that same base brief (when present). An unreadable brief fails closed.

When the brief is not on the merge base yet (first PR / undeclared scope), there is no story path fence from this gate — class checks remain #4980.

### Test roots are free

Paths under configured test roots (and fixtures) pass and spend nothing. `CHANGELOG.md` is free. The fence and the budget apply to **production roots only**.

### Production allowance

Allowance = clamp(count of **concrete** production files on the merge-base `file_scope`, floor **2**, cap **5**). A glob entry is not a concrete file.

- Production paths inside the base list (including glob matches) land without spending.
- Production extras within the allowance land.
- Paths past the cap split to a follow-up story as an independently valid change, or the story stays blocked and is replanned. **No prompt.** Unrelated / low-confidence are not selectors. Parent text and model output are not an allow input.
- Remediation does **not** name `scope:record-approved-scope` or `--kind renewed-approval`.

### What this remedy does not do

- No pre-Wave-1 root-count refusal.
- Protected-glob / class checks are **#4980** (not defined here).
- Legacy `.deft/approved-scope` records may still exist for intent-pin history (#3385). Same-PR rewrite of those files with the active brief still hard-fails. Proceed does not write them for scope.

## Operator command: `scope:record-approved-scope` (legacy / authz-adjacent)

The verb remains for historical intent-pin minting and for `authz`-shared human-presence machinery. **It is not part of the proceed path** and is not the remediation for production-scope-over-budget (#4956). Prefer `deft scope:record-approved-scope` (consumer include-only: `task deft:scope:record-approved-scope`).

`--actor` is display only. Mint uses the shared #3110 human-presence gate (TTY, `--confirm`, typed phrase `mint` for that verb). Agent/CI env markers refuse.

## Working-tree / untracked files

`verify:scope-provenance` unions:

1. `git diff --name-only <base>...HEAD`
2. `git diff --name-only HEAD`
3. `git ls-files --others --exclude-standard`

and lists on-disk `xbrief/active/` files. Presence in the working tree is what matters for discovery. The **fence list** still comes from the merge-base brief bytes.

## Cohort proceed

On in-harness proceed for an N-story cohort: do not stop for scope. Land planner briefs (with `file_scope` when declared) on the base before workers branch. After proceed, schedule no scope ceremony — see `deft-directive-swarm` and the AGENTS managed pin (#4956).
