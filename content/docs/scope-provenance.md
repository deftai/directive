# Scope provenance (`verify:scope-provenance`)

Refs: #3145 · #3205 · #4956 · #4774 · #5192 · #3715 · Related: #1310, #2944 human-origin grants, #516 file scope · class checks: #4980 · generalizes under [gate-integrity.md](./gate-integrity.md) (#3156) · UI structure: [observable-scope.md](./observable-scope.md) (#4495)

## Problem

An implementation PR could edit its own active xBRIEF to add new paths, after which gates stayed green. The modified head brief became its own authorization source. Separately, operator proceed on a swarm cohort still stopped for leave-harness `scope:record-approved-scope` ("mint") per story (#4956). Membership then hard-required a human mint even when a concrete merge-base brief already matched (#5192).

## Contract (#4956 / #5192)

**After proceed there is no scope ceremony to schedule.** Proceed writes nothing: no `.deft/approved-scope` record, no typed mint phrase, no `scope:record-approved-scope` for proceed or for a later path-list growth. `authz:grant` keeps the phrase `mint` (#3110).

### Fence = merge-base brief `file_scope` (production fence)

The **production fence** is the active brief's `plan.metadata.swarm.file_scope` **on the merge base**. That declaration is agent-authored precommitment. The fence is a drift check against that list, not a human authorization of the paths.

Two builds carry it:

1. **Merge-time check** (`verify:scope-provenance` / `task check`) compares **changed production files** to the base brief. It does **not** read the head brief for the allow list. A PR that adds production paths and edits its own active brief to include them still fails.
2. **Write fence** reads that same base brief (when present). An unreadable brief fails closed.

When the brief is not on the merge base yet (first PR / undeclared scope), there is **no production fence** from this gate — class checks remain #4980. Membership still fail-closes first-PR product paths that ride with the active brief and have no continuity-resolved base brief (#5192).

### Merge-base empty-skip posture (#3715)

Empty or absent merge-base `file_scope` yields **no production-fence finding**. That empty-skip is **accepted posture**, not a tolerated gap to close by counting `.deft/approved-scope` engagement. Do not Bound this fence on historical approved-scope ratios, soft-warn cites, or a causal "briefs decline to declare" sentence. Membership and class checks (#4980) stay separate and are not weakened (#3156).

Authoring coverage (do not overstate): empty or missing `file_scope` is hard-refused on `scope:decompose` story validation, and nonempty `file_scope` is required for swarm-allocation readiness. Setup instructs nonempty declaration (#4988, supersedes closed #4383). Briefs authored without a swarm block reach neither gate; that path is ungated in code. Extending nonempty `file_scope` where absent (option b) prices as covering that no-swarm-block authoring route plus backlog — not as residual-path coverage. Raise-declaration options stay sequenced after #3714 notice (recut before ship-as-filed).

### Production fence: test roots are free

On the **production fence only**, paths under configured test roots (and fixtures) pass and spend nothing. `CHANGELOG.md` is free. The fence budget applies to **production roots only**. Membership does **not** free test or fixture roots (#5192).

### Production allowance

Allowance = clamp(count of **concrete** production files on the merge-base `file_scope`, floor **2**, cap **5**). A glob entry is not a concrete file.

- On the production fence: production paths inside the base list (including glob matches) land without spending; extras within the allowance land.
- On membership: a present mint may use glob matches; missing-mint Path B admits **concrete** merge-base entries only (glob-only Path B is residual — docs do not promise those matches land without a mint). Source-root extras spend the same allowance; undeclared test/fixture and other non-allowlist paths refuse.
- Paths past the cap split to a follow-up story as an independently valid change, or the story stays blocked and is replanned. **No prompt.** Unrelated / low-confidence are not selectors. Parent text and model output are not an allow input.
- Missing-mint membership remediation is **split, or land a widened concrete brief on the merge base**. Remediation does **not** name `scope:record-approved-scope` or `--kind renewed-approval`.

### Membership (#4774 / #5192)

When the bound story is in the change set:

1. A human-stamped merge-base mint for the **continuity-resolved** story is the allowlist when present (planId match ignores stale `xbriefRelPath`; no-`plan.id` is path-first + basename-keyed mint with matching `xbriefRelPath`).
2. Otherwise membership evaluates against the merge-base brief's **concrete** `file_scope` as agent precommitment. Head brief cannot widen.
3. Free paths: bound brief, verified peer briefs, `CHANGELOG.md`, and continuity lifecycle paths of the bound identity. An xBRIEF-only change set may omit a mint.
4. Empty / invalid / unreadable mint records fail closed (they are not absence).

### What this remedy does not do

- No pre-Wave-1 root-count refusal.
- Protected-glob / class checks are **#4980** (not defined here).
- Legacy `.deft/approved-scope` records may still exist for intent-pin history (#3385). Same-PR rewrite of those files with the active brief still hard-fails. Proceed does not write them for scope.
- Does not free test/fixture roots in membership, treat glob matches as membership without a mint, or restore leave-harness proceed mint as the Path B remedy (#5192).

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
