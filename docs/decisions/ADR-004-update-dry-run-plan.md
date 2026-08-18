# ADR-004: `deft update --dry-run` plan is construction-level collection (side-effect port)

**Status**: accepted — operator acceptance of #3462 Current shape (pass-2) on 2026-08-18, with three conditions recorded below.

**Date**: 2026-08-18

**Related**: #3462 (this decision), #3437 (consumer bug — stays open until the replacement PR merges), #3452 (tripwire), #3392 / #3458 (chokepoint), PR #3453 (halted; disposition **replace**), PR #3464 (tier-1 version-skew headline, already merged).

## TL;DR

Dry-run fidelity is a property of **construction**, not helper discipline. Dest mutations on the `deft update` path go through **one injected write / remove / exec port**. A plan is the recorded calls. Collect-only mode and a labeled two-tree dest-vs-content-package diff are rejected. PR 3453 closes unmerged after salvage. #3437 closes when the replacement that implements this ADR merges.

## Context

PR #3453 tried collect-only planning: run the writers under a ledger, skip dest IO. It failed to stabilize after three batches and five bypass instances. The fifth — `writeConsumerGitHooks` running `git config core.hooksPath` on dry-run — proved the write surface is not one category. A static `node:fs` import ban was already green while dest still mutated.

#3462 named a presumptive mechanism (pure-read dest-vs-content-package diff + declared exclusions). One critic refuted it on SHA `2f6e4ce1`: file semantics are dest-aware merge / preserve / opt-out / strip, not “make dest match projected content.” Dest membership lives in ~16 writer files / ~30 dest-set branches. Reimplementing those as a “pure read” is a parallel writer. The declared-exclusions contract is omission-shaped (same class as the five bypasses).

The issue’s own fallback then applied: construction-level collection. Operator accepted that Current shape on 2026-08-18 with the three conditions in this ADR.

Consumer question (#3437): **which existing dest files will this run delete or overwrite, versus preserve as consumer-owned?** Version-skew honesty already shipped in #3464. File-level blast radius waits on this architecture.

## Decision

1. **Mechanism: side-effect port (construction-level collection).** Every dest mutation on the `deft update` / dry-run path — file write, dest remove, `chmod`, and dest-affecting `child_process` / `git config` — goes through one injected interface. Dry-run binds the same port in collect-only (or equivalent record) mode. The plan **is** the recorded calls. No second implementation of dest-membership logic.
2. **PR 3453 disposition is replace.** Do not revive collect-only. Do not implement the labeled two-tree diff as its successor. Salvage architecture-independent pieces (static import-ban test, `removeStaleMigratedFrameworkNarrative` → `containedRemove`, zero-mutation fixture), then close 3453 unmerged. The branch stays as the road-not-taken reference.
3. **#3437 stays open** until the replacement PR that implements this ADR merges. `Closes #3437` must not fire from 3453.

### Condition 1 — Enforcement legs, not just the interface

The port only collects what flows through it. Both legs are required:

- **(a) Static ban, extended.** Dest-writing path MUST NOT import raw dest-mutating `node:fs` (`rmSync`, `writeFileSync`, `renameSync`, `copyFileSync`, …) **or** dest-mutating `child_process` / `execFileSync("git", …)` invocations. Allowlist = the port implementation module(s) only. Instance 5 proved the fs-only ban is green while `git config` mutates (`scaffold.ts:487-496` on `2f6e4ce1`). The extended ban is what makes “every dest mutation goes through the port” CI-enforced rather than declared.
- **(b) Zero-mutation invariant.** Dry-run MUST leave the fixture tree byte-identical. Retain the hash / planted-stale-narrative fixture as the runtime backstop.

### Condition 2 — Migration is consolidation, not introduction

`setHooksPath` is already behind an injected seam (`GitHooksSeams` at `scaffold.ts:430-432`; default still `execFileSync` git config at `scaffold.ts:487-496`). The replacement MUST inventory existing one-off seams and **fold them into the port**, not wrap a fresh parallel abstraction around them.

**Inventory of dest-mutating one-off seams on the update path (count = 3), SHA `9053a4ad` / prior-art `2f6e4ce1`:**

| # | Seam | Where | What it mutates |
|---|------|--------|-----------------|
| 1 | `GitHooksSeams.getHooksPath` / `setHooksPath` | `scaffold.ts:430-432`, used `476-502` | `.git/config` `core.hooksPath` |
| 2 | `RefreshDepositSeams.copyContent` | `refresh.ts:136` | tree swap of `.deft/core` |
| 3 | `RefreshDepositSeams.runOrgForceOn` | `refresh.ts:152` | trusted-org policy files |

`containedWrite` / `containedRemove` (`packages/core/src/fs/contained-write.ts`) are the existing file-IO chokepoint. The port **is** that chokepoint extended to exec / chmod, with the three seams above folded in. Read-only injectors (`resolveContentRoot`, `gitLsFiles`, `gitPorcelain`, version readers) stay reads.

This count is the recorded migration cost. If a later inventory finds more dest-mutating injectors on the update path, amend this ADR; do not silently add a fourth wrapper.

### Condition 3 — Honest label survives

Anything the port genuinely cannot capture (today: effects outside the project root such as OpenClaw `$HOME` skills, until those calls are ported) stays in a **printed exclusions label** with a content-contract test. The label **shrinks as the port grows**. It never silently disappears. ⊗ Drop the label because the port exists. ⊗ Grow the label instead of folding a seam.

## Consequences

### Enables

- Dry-run answers #3437’s dest-membership question from recorded port calls.
- Static ban + zero-mutation fixture make bypass CI-red, including `git config`.
- 3453 can close unmerged without losing the import-ban test, stale-narrative `containedRemove`, or zero-mutation fixture.

### Requires

- Replacement scope xBRIEF with `intended_placement`, refs 3453 as prior art, implements this ADR.
- Salvage PR before 3453 close (import-ban contract test; `removeStaleMigratedFrameworkNarrative` → `containedRemove`; zero-mutation fixture including planted `xbrief/vbrief.md`).
- Reassign the #3437 active brief to the replacement story in the 3453 closing comment (`verify:orphan-active` will not catch it while #3437 stays open).

### Does not authorize

- Reviving collect-only on 3453.
- Implementing the labeled two-tree dest-vs-content-package plan as the architecture.
- Materialize-and-diff (scratch dir + same write code), unless a later ADR shows the port’s migration cost worse than root-parameterizing `git config` and `$HOME` OpenClaw.
- Closing #3437 from 3453 or from the salvage PR.
- Expanding `installerManagedMatchers()` into a dest-membership oracle.

## Alternatives considered

- **Collect-only (as shipped on 3453).** Rejected: five bypass instances; omission-shaped; fs-import ban cannot see `child_process`.
- **Labeled pure-read dest-vs-content-package diff.** Rejected by critic + operator: dest membership is writer logic (~16 files / ~30 branches); exclusions contract is omission-shaped; cannot answer which dest files are deleted vs preserved.
- **Materialize-and-diff.** Rejected as default: every side effect must be root-parameterized; `git config` already is not; scratch would need a git repo; honest form collapses into the port.
- **Defer architecture and keep parking 3453.** Rejected: #3437 remains a lying dry-run for file-level blast radius; version-skew (#3464) is not the whole consumer question.

## References

- Current shape: https://github.com/deftai/directive/issues/3462#issuecomment-5329671479
- Operator acceptance + three conditions: https://github.com/deftai/directive/issues/3462#issuecomment-5330417455
- Tripwire arc: https://github.com/deftai/directive/issues/3452#issuecomment-5329070333
- Issues: #3462, #3437, #3452, #3392, #3458
- PRs: #3453 (replace), #3458 (precursor), #3464 (tier-1 skew)
