# Scope provenance (`verify:scope-provenance`)

Refs: #3145 · #3205 · #4956 · #4774 · #5192 · #3715 · Related: #1310, #2944 human-origin grants, #516 file scope · class checks: #4980 · generalizes under [gate-integrity.md](./gate-integrity.md) (#3156) · UI structure: [observable-scope.md](./observable-scope.md) (#4495)

## Problem

An implementation PR could edit its own active xBRIEF to add new paths, after which gates stayed green. The modified head brief became its own authorization source. Separately, operator proceed on a swarm cohort still stopped for leave-harness `scope:record-approved-scope` ("mint") per story (#4956). Membership then hard-required a human mint even when a concrete merge-base brief already matched (#5192).

## Contract (#4956 / #5192)

**After proceed there is no scope ceremony to schedule.** Proceed writes nothing: no `.deft/approved-scope` record, no typed mint phrase, no `scope:record-approved-scope` for proceed or for a later path-list growth. `authz:grant` keeps the phrase `mint` (#3110).

### Fence = merge-base brief `file_scope` (production fence)

The **production fence** is the active brief's `plan.metadata.swarm.file_scope` **on the merge base**. That declaration is agent-authored precommitment. The fence is a drift check against that list, not a human authorization of the paths.

Two builds carry it:

1. **Merge-time check** (`verify:scope-provenance` / `task check`) compares **changed paths** to the base brief through the extra-path rule below. It runs whether or not the brief is in the change set (the Path-independent check). It does **not** read the head brief for the allow list. A PR that adds production paths and edits its own active brief to include them still fails.
2. **Write fence** reads that same base brief (when present) and applies the same extra-path rule to each Write or Edit. An unreadable brief fails closed.

When the brief is not on the merge base yet (first PR / undeclared scope), there is **no production fence** from this gate — class checks remain #4980. Membership still fail-closes first-PR product paths that ride with the active brief and have no continuity-resolved base brief (#5192).

### Merge-base empty-skip posture (#3715)

Empty or absent merge-base `file_scope` yields **no production-fence finding**. That empty-skip is **accepted posture**, not a tolerated gap to close by counting `.deft/approved-scope` engagement. Do not Bound this fence on historical approved-scope ratios, soft-warn cites, or a causal "briefs decline to declare" sentence. Membership and class checks (#4980) stay separate and are not weakened (#3156).

Authoring coverage (do not overstate): empty or missing `file_scope` is hard-refused on `scope:decompose` story validation, and nonempty `file_scope` is required for swarm-allocation readiness. Setup instructs nonempty declaration (#4988, supersedes closed #4383). Briefs authored without a swarm block reach neither gate; that path is ungated in code. Extending nonempty `file_scope` where absent (option b) prices as covering that no-swarm-block authoring route plus backlog — not as residual-path coverage. Raise-declaration options stay sequenced after #3714 notice (recut before ship-as-filed).

### Extra paths: one rule for three checks (#6221)

Three checks read a story's `file_scope`: the **write fence** (each Write or Edit), **membership** (when the brief is in the change set) and the **Path-independent check** (the production fence above, on every PR). They use one rule for a path the brief does not declare (an *extra*). Code: `packages/core/src/scope-provenance/extra-path-admission.ts`.

**Allowlist authority.** All three use the same allowlist: the human-stamped merge-base mint when present (or the admitted one-PR mint, #6273 / #6361), else the merge-base brief's **concrete** entries. Under a mint, glob entries match. Without a mint, a glob entry admits nothing on its own: a path it matches is an extra. On the write fence and the Path-independent check a declared path must also match the merge-base brief, so a broader mint does not widen the brief. #6203 forge approval is membership only; it is never write authority.

**Delegated stamps (#7420).** A mint written under a live TOTP delegation carries `humanApproval: {kind: "operator-delegated", mintedVia: "delegated-totp", delegationId, expiresAt}`. The merge-base mint lookup in `verify:scope-provenance` (`evaluate.ts`) is the one reader that accepts it, and only while that delegation is the live one on this machine and before `expiresAt`. After the delegation ends the same stamp reads as "lacks human stamp" and fails closed. Every other approved-scope reader calls `isHumanApprovalStamp` and refuses it: the write-fence budget, the one-PR proof, renewed approval, the durable-effect and presentation ceilings, presentation coverage. On CI there is no live delegation, so a delegated stamp does not admit there. Contract: [operator-delegation.md](./operator-delegation.md).

**Classes and spend.**

| Extra path | Write fence | Membership | Path-independent check |
|---|---|---|---|
| Source root (production) | spends the allowance | spends the allowance | spends the allowance |
| Test or fixture, modify of a path on the base | spends the allowance | spends the allowance | spends the allowance |
| Test or fixture, add, delete or rename | refused | refused | refused |
| Other (not source, test or fixture) | refused | refused | ignored (named residual) |

Free paths never spend: `CHANGELOG.md` and changelog fragments, the bound brief and brief records, verified peer briefs and continuity lifecycle paths (membership).

**Budget.** Allowance = clamp(count of **concrete** production files on the merge-base `file_scope`, floor **2**, cap **5**). A glob entry is not a concrete file. On the write fence the budget counts the story's whole change set: merge base to the working tree (committed, staged, unstaged), untracked files, and every target of the pending operation. A path already counted spends nothing again. If that inventory cannot be read, the write is refused (fail closed).

**Refusal.** Past the allowance all three checks refuse with the reason token `extra-paths-over-budget`. A path the budget never admits is refused with `extra-path-not-admitted`. The remedy is a split to a follow-up story, or a widened concrete brief on the merge base; for a glob brief without a mint, replace the glob with concrete entries. Paths past the cap split as an independently valid change, or the story stays blocked and is replanned. **No prompt.** Unrelated / low-confidence are not selectors. Parent text and model output are not an allow input. Remediation does **not** name `scope:record-approved-scope` or `--kind renewed-approval`.

**Report.** On success `verify:scope-provenance` lists each extra path with its class (`production|test|fixture|other`) and spend (`spent|free`), per story and check, and appends the list to `$GITHUB_STEP_SUMMARY` when set. A `free` other-class row on the Path-independent check is not write permission; membership and the write fence refuse it.

**Warn first (#6281).** The refusals this rule adds are declared rows that ship in `warn` mode for one release, with no immediate-enforcement exception: `extra-path-not-admitted` (a test or fixture add, delete or rename outside `file_scope`) and `extra-paths-over-budget` (test or fixture extras past the allowance). On the Path-independent check and the staged scope-cover the line prints and the check passes; at the write fence a path the brief's glob matched before this rule is admitted with the line. In a later release (`enforce`) the same line is the refusal. Refusals that existed before this rule, such as production extras past the allowance on the Path-independent check, and every membership refusal, are unchanged.

**Unchanged.** The budget never overrides a missing declaration, an invalid mint, project allow or deny paths, story deny paths, protected stores or active-brief protection. The empty-base skip (#3715) stays: no merge-base `file_scope`, no Path-independent finding. Membership still does not free test or fixture roots (#5192): a test path spends the allowance like a production extra.

**Named residual (other class).** An undeclared path that is neither source, test nor fixture (for example a doc) is refused at membership and the write fence, and ignored by the Path-independent check. This is a choice, not fence parity for that class.

**Shell writes.** The write fence sees Write and Edit and the shell forms the hook recognizes. A shell delete, `git apply` or `sed -i` it does not see is caught by the PR check only.

### Declaration hides a strict axis (#6591)

`x-directive/requires` and its seven aliases (the eight declaration fields `inferRequiredStrictAxes` reads) can turn off an axis the clause text infers. For example, `"x-directive/requires": "merge"` on "Deploy to staging and confirm the site serves the new build" empties the axis set, so `scope:complete` accepts `kind: test` or `kind: review` evidence for a deploy clause.

**What it compares.** For each brief modified in the change set, the check reads the merge-base copy through the same continuity and pre-move resolution as the production fence, so a head brief under `completed/` or `cancelled/` is compared with its pre-move copy. It prints one line for a head item when all three hold:

1. The resolved merge-base copy of the brief is under `xbrief/active/`.
2. The item is not on that copy, or one of the eight declaration fields has a different value on the base item. Items match by `id`; an item with no `id` matches by its position in the item tree.
3. The head item hides an axis that the base item does not hide. An item hides the axes its text infers with the declaration fields ignored, minus the axes it infers as written. An item that is not on the base hides none there.

An activation (`pending/` to `active/`) does not print: its merge-base copy is under `pending/`. A title edit under an unchanged declaration, an evidence-only edit, and `x-directive/requires: deploy` on text that infers only deploy do not print. Code: `packages/core/src/scope-provenance/declaration-hides-axis.ts`.

**Warn only (#6281).** The declared row `declaration-hides-axis` ships in `warn` mode. The line prints with the success report; the exit code does not change and the line is not an intent-pin finding. This row has no `enforce` mode yet, and no new `x-directive/requires` value ships with it. The fix is a brief edit in the same change: remove the added declaration (this clears the line), or record the evidence the clause requires (the line still prints while the declaration stays). The printed `deft verify:scope-provenance` only re-checks.

**Authority.** A declaration that is already on the merge-base active brief is agent precommitment reviewed at activation, not human authorization. The row stays quiet on it and does not read it as consent. When the brief has an intent pin, the same edit already fails as `intent-drift` / `unclassified-key`; this row covers the unpinned path. Rewording the clause text with no declaration change is not covered here; it stays on the general warn-only `legacy-intent-edit` finding.

**Advisory.** The strict-axis advisory (#6272) lists an item whose declaration hides a text axis as a declared row, after the count; the count stays on the axes `scope:complete` holds. At `scope:promote` and `scope:activate` it names `x-directive/requires`; at `xbrief:preflight` (an active brief) it does not suggest a declaration.

### Membership (#4774 / #5192)

When the bound story is in the change set:

1. A human-stamped merge-base mint for the **continuity-resolved** story is the allowlist when present (planId match ignores stale `xbriefRelPath`; no-`plan.id` is path-first + basename-keyed mint with matching `xbriefRelPath`).
2. Otherwise membership evaluates against the merge-base brief's **concrete** `file_scope` as agent precommitment. Head brief cannot widen, except under a qualifying forge approval (#6203) or a mint-level same-PR record (#6273), both below.
3. Free paths: bound brief, verified peer briefs, `CHANGELOG.md`, and continuity lifecycle paths of the bound identity. An xBRIEF-only change set may omit a mint.
4. Empty / invalid / unreadable mint records fail closed (they are not absence).

#### Forge-approved head brief (#6203)

A PR can carry a new or widened brief plus its code when a human approves it on GitHub. With PR context (`--pr N` / `--repo OWNER/NAME`, or `GITHUB_PR_NUMBER` / `GITHUB_REPOSITORY` in CI), a failing membership check under precommitment or missing authority consults the forge. When a qualifying approval exists, membership evaluates against the **head** brief's concrete `file_scope` instead of the merge-base brief.

- **Mint wins.** A present mint keeps the mint path. The forge is never consulted.
- **Auth-hash v1** (`sha256:` over canonical JSON; strings byte-exact, no Unicode normalization) covers `plan.id`, the xbrief path, the concrete `file_scope`, and the acceptanceCriteria array: `plan.acceptance`, `plan.narratives.AcceptanceCriteria`, and each item's `narrative.Acceptance`, in document order. `productPullRequest` and other delivery metadata stay out, so a PPR stamp keeps the approval. Any change to the covered fields drops it.
- **Qualifying approval:** the reviewer's latest deciding review (APPROVED / CHANGES_REQUESTED / DISMISSED) is APPROVED; the reviewer is a `User` (not Bot or App), not the PR author, and has `write`, `maintain` or `admin` on the repo; the repo is the checkout's `origin` (a `--repo` value may only confirm it, so a fork's approval never counts) and is the PR's base repo; the evaluated HEAD is the PR head (or GitHub's merge commit whose second parent is the PR head); and the brief at the reviewed commit hashes the same as the head brief.
- **Fallback:** missing PR context, no qualifying approval, a hash mismatch, or an unavailable forge keeps today's Path B or mint finding unchanged. The result message adds one `forge approval (#6203)` line with the reason.
- **Membership only.** The production fence still reads the merge-base brief. A widened brief can pass membership and still fail `production-scope-over-budget`. A brand-new brief has no production fence (as today).
- **Re-run after approval.** Approval does not re-trigger CI. Re-run the merge gate (or push) after the approval lands.
- **Residual (#6207):** an agent that holds a second human forge token can satisfy every predicate above. The hash binds the approved bytes; it does not prove independent human intent and does not close that confused-deputy risk. That posture stays open on #6207.

Code: `packages/core/src/scope-provenance/forge-approval.ts`.

#### One-PR proof level (#6273)

The repo owner picks how a new or widened brief can land with its code in one PR, without a second reviewer. The field is `plan.policy.onePrScopeProof`:

| Level | Behaviour |
|---|---|
| `off` (default; also when the field is absent) | Today's behaviour. A same-PR `.deft/approved-scope` record is refused. |
| `mint` | A same-PR human mint record can admit the head brief for membership. Works with or without `requireHumanMerge: true`; the control differs (see below). |
| `signed` | Reserved for the signed level (#5862). The setter refuses it; a merge base that sets it gets no one-PR path. |

Set it with `deft policy:set-one-pr-scope-proof -- --set off|mint --confirm`. Inspect it with `deft policy:show --field=onePrScopeProof`.

`scope:record-approved-scope` keeps the terminal mint (#7031): its record is live authority for the write fence inside the session, before any PR exists. The observable-scope and intent-constraint records are different: `scope:record-observable-scope` and `scope:record-intent-constraint` write a declared record from any shell, and you write the declaration and land it before the product PR. A declared stamp is never a human stamp, so it never admits a brief here. The full list is in [human-origin-authz.md](../contracts/human-origin-authz.md) § Operator mint inventory.

- **Merge base only.** The check reads `onePrScopeProof` and `requireHumanMerge` from `xbrief/PROJECT-DEFINITION.xbrief.json` on the merge base, never from the head. A PR that changes either field cannot use the one-PR path.
- **No human-merge precondition (#6354).** The mint level applies whatever the merge-base `requireHumanMerge` is. An agent or the merge queue may merge the PR. `requireHumanMerge` only decides which control applies (below).
- **How to use it.** The human runs `scope:record-approved-scope` on the brief (same #3110 human-presence gate). The record now also stores `authHashV1`, the brief's auth-hash v1 (same hash as #6203). Commit the record, its `.intent.json`, the brief and the code in one PR. List both `.deft/approved-scope/<plan-id>.json` and `<plan-id>.intent.json` in the brief's `file_scope`, because membership does not free them.
- **Exact match only.** The record is admitted only when all of these hold: `authHashV1` equals the head brief's auth-hash; `planId` and `xbriefRelPath` match the head brief; the record's normalized `fileScope` equals the head brief's `file_scope` and `fileScopeDigest` matches it; the head `file_scope` has **no glob entries** (concrete files only); the human stamp passes; and the same-PR `.intent.json` matches the record's `intentDigest` with no intent drift in the head brief. Any edit to the brief after the mint needs a new mint.
- **Then** membership uses the record as `mint` authority. In every other case the same-PR rewrite finding is unchanged; when the merge-base level is `mint`, the message adds one `one-PR scope proof (#6273)` line with the reason.
- **CI cannot verify the mint.** CI cannot tell a real mint from a file an agent wrote. The control depends on the merge-base merge policy:
  - **`requireHumanMerge: true`:** the human merge is the control, the same trust anchor as today's separate record PR. The admit block ends with "CI cannot tell this mint from a file an agent wrote; the human merge is the control".
  - **`requireHumanMerge` false or absent:** CI verifies nothing human. The control is the local mint gate (the #3110 human-presence gate on `scope:record-approved-scope`) and the write fence's always-on protected-store deny on `.deft/approved-scope/`. The rest of the write fence is not a separate control here, because it reads the same mint (#6361, below). This is the same class of control as a brief PR that an agent opens and merges. The admit block ends with "CI cannot tell this mint from a file an agent wrote; requireHumanMerge is not true on the merge base, so CI verifies nothing human: the control is the local mint gate and the write fence's protected-store deny on .deft/approved-scope/; a record written by a shell form that deny misses (#3597, #3595) also reaches local scope admission".
- **Admit block.** On each admit, `verify:scope-provenance` prints the plan id, the admitted `file_scope`, the production-file count, the merge-base `requireHumanMerge` value and the control line above. It appends the same block to `$GITHUB_STEP_SUMMARY` when that variable is set. Read that block before you merge.
- **Worker path (#6361).** A one-PR brief is not on the merge base, so the local write fence used to give it an empty fence. Now, when a brief is absent from the merge base, the one fence loader admits the working-tree brief's `file_scope` only when the merge-base level is `mint` and the same-PR record matches that exact brief. It uses the same two checks as CI (`evaluateOnePrScopeProofGate` and `evaluateMintLevelRecord`) and reads the brief, record and preimage again on every call, so an edited brief is refused at the next Write. The always-on protected-store deny still refuses Write and Edit to the record pair, even though `file_scope` lists them. When the mint does not admit, the deny prints the reason and names `scope:record-approved-scope` (promote or activate would void the mint). A brief that is on the merge base keeps its merge-base fence; the head copy is ignored (#4956).
- **Launch from the one-PR branch (#6361).** Push the one-PR branch and run `swarm:launch -- --base-branch <branch>`. When a brief is not on `origin/<deliveryBranch>`, launch accepts it if it is on `origin/<branch>` and the same two checks admit it at that tip against its merge base with the delivery tip. The dest worktree is created from `origin/<branch>`; no brief or record bytes are copied. Finalize and the fresh-clone rules (#4714) are unchanged.
- **Cohort mint and per-story launch (#7083).** For a cohort, give each story its own branch that carries only its activated brief. `scope:record-approved-scope -- --manifest <file>` prints each story's plan id, brief, worktree, `file_scope`, acceptance criteria and intent digest, takes the typed `mint` once, and writes each record pair into that story's own worktree. Each record is the same per-brief record the mint level admits; the printed `cohortDigest` is metadata, not authority. Commit each pair on its own branch, then run `swarm:launch` with a worktree map whose rows name each story's branch as `base_branch`: launch runs the same two checks at each branch's tip and builds each dest from that branch's pinned commit. A product PR never carries a peer's brief or pair, so membership and the story-line check see one story. With one `--base-branch`, launch behaves as before. Batched counts: [commands.md](../commands.md) § Batched cohort flow.
- **Residual without a human merge.** The level is only as strong as the protected-store deny on `.deft/approved-scope/`. Shell writes can bypass that deny today (#3597, #3595), and since #6361 such a record also reaches local scope admission. This is not closed.
- **Unchanged:** the #4956 production fence (merge-base brief only), Path B, the separate mint-record PR, #6203 forge approval, and `requireHumanMerge` semantics. A widened brief can pass membership and still fail `production-scope-over-budget`.
- **Not in scope:** credential separation for an agent that shares the operator's forge identity stays on #6207. Observable-scope and intent-constraint records can opt in to WebAuthn approval via `.deft/approvers.json` (#6945). `plan.policy.onePrScopeProof` `signed` stays reserved (#5862); cohort consent (#6284) may reuse that trust root later. The production allowance split stays under #4956. The mint level closes none of those.

Code: `packages/core/src/policy/one-pr-scope-proof.ts`.

#### Path A planning split (#5551)

When an active implementation brief is **outside** the change set, membership is a no-op for that identity (Path A). Supported planning publication is two change sets, not one:

1. **PR-1 — planning package:** pending/proposed briefs, root plan/specification/PROJECT-DEFINITION companions, docs/decisions, and optional `.deft/plan-sequence.json` — with **no** active brief in the change set. Coverage may N/A after closed-shape / closed-pointer proof; membership does not bind companions to an absent active fence.
2. **PR-2 — active lineage retarget:** the active brief alone (plus free paths such as `CHANGELOG.md`) when only lifecycle lineage refs move. No content predicate frees planning paths because the active diff is lineage-only.

`.deft/plan-sequence.json` is **never** membership-freed. Coverage inertness / N/A is **not** membership authorization for sequence, plan, spec, pending briefs, production fence, intent, identity, or lifecycle checks. `authorized_by`, narrative text, and head-authored confirmations are not consent; keep `verify:plan-sequence` and spec-guard on those records.

#### Committing the planning package (#5839)

The commit hook's prospective scope-cover (#5656) admits a **planning-publication** staged set without a ready scope. The check runs on the raw staged index entries before the ready-scope guard. It admits the set only when every staged path is one of:

- **Inventory:** `CHANGELOG.md` (or a changelog fragment), `.deft/plan-sequence.json`, `docs/design/<name>.md`, `docs/decisions/<name>.md`.
- **Record files:** `<name>.xbrief.json` or `<name>.vbrief.json` directly in `proposed/`, `pending/`, `completed/` or `cancelled/`, and `<name>.decision.json` directly in `xbrief/decisions/` or `vbrief/decisions/`.

`<name>` is one path segment with no backslash. Each entry must be added or modified as a regular file (mode 100644), or deleted. A staged `.deft/plan-sequence.json` must pass the closed plan-sequence shape check on its index blob (an `insert_approvals` row from an approved insert passes). Nothing else is read. Any other path, a symlink, an executable, a typechange or a failed shape check means the set is not admitted, and today's rules decide the commit. Admission writes nothing and gives no merge-time credit: membership, coverage and `verify:plan-sequence` still run at the PR boundary.

**Consumer recovery:**

1. Upgrade to the first release that carries this admission. Older runtimes still deny the commit.
2. Commit the documents, stories, decisions and plan-sequence file **before** `scope:promote`, because promotion rewrites the root plan files. If you already promoted, split them out into their own commit.
3. Commit root `plan` / `specification` / `PROJECT-DEFINITION` changes in a separate commit (an `xbrief/`-only commit already passes).
4. A change under `active/` is not admitted with `CHANGELOG.md`, a document or the plan-sequence file. Put lifecycle files in their own commit and the rest in another.
5. A set with any path outside the inventory and record files is not admitted; it still needs a ready covering scope.

Code: `packages/core/src/hooks/planning-publication.ts`.

**Write-time requirements posture:** pending briefs and root plan/specification are merge-time (Path A / activation), not write-time under an active implementation fence. Do not widen write-time requirements-posture to admit them while the active story fence is live. Stale `parent_lineage` `target_path` values that still name `proposed/` after briefs move to `pending/` recover via unique-`plan.id` / documented parent_lineage resolver — not a membership exemption.

### What this remedy does not do

- No pre-Wave-1 root-count refusal.
- Protected-glob / class checks are **#4980** (not defined here).
- Legacy `.deft/approved-scope` records may still exist for intent-pin history (#3385). Same-PR rewrite of those files with the active brief still hard-fails, except at the merge-base one-PR mint level (#6273). Proceed does not write them for scope.
- Does not free test/fixture roots in membership, treat glob matches as membership without a mint, or restore leave-harness proceed mint as the Path B remedy (#5192).
- Does not add a one-PR lineage-unlock that frees planning paths from an active-brief lineage-only predicate (#5551 named residual).
- Does not treat coverage N/A or inert classification as membership authorization (#5551).

### Path B activation vs `productPullRequest` (#5387)

Membership-land (Path B activation) PRs that only touch nonterminal `xbrief|vbrief` under `proposed|pending|active` plus optional root `CHANGELOG.md` leave `metadata.productPullRequest` **unset**. Closing-keywords admits that brief-land shape when body has `deft-story: N` or `deft-story-part: N` covering each changed nonterminal (part lines count offline and live, so one PR can activate a cohort, #7083) (`isBriefLandShapedDiff` + early return in `evaluateFullStoryMarkAdmission`). Optional `metadata.activationPullRequest` is provenance only — delivery readers ignore it. The stacked product PR stamps virgin `productPullRequest` on the existing null path; leftover keeps the original product stamp. ⊗ Write the activation PR number into `productPullRequest`. Legacy stamped activations unstamp once, then product stamps. Depth: `packages/core/src/pr-closing-keywords/main.ts`.

### Path B activation vs product `verify:ac` (#5792)

Scope-only Path B activation must be able to clear `deft check` before merge-base write authority exists. Check inventories the complete local change set (merge-base..HEAD ∪ dirty ∪ cached ∪ untracked, with rename origins) into `PrDiffPath`, then reuses the Path B witness (`evaluatePathBActivationAdmit`). Inventory base prefers typed `plan.policy.deliveryBranch` / remote default before `master`|`main`, and git-toplevel paths are remapped to `projectRoot` so nested consumers keep brief-land shape. When the inventory is brief-land shaped and the witness admits, check records one named disposition `path_b_activation_deferred` and **defers** product acceptance commands and artifact-clause execution — it does not selectively forgive opaque npm failures and does not bank as a later product verified-pass. Local check without a PR body uses inventory brief issue-ref identity instead of `deft-story` marks; when a PR body is present, mark coverage still applies. Any product path in the inventory, or `productPullRequest` set, restores full `verify:ac`. Write authority stays merge-base-only (`loadStoryWriteFenceFromMergeBase` unchanged). Depth: `packages/core/src/verify-ac/evaluate.ts`, `packages/core/src/check/cached-orchestrator.ts`.


## Historical ship-closeout for stale merged actives (#5403)

Already-shipped briefs can remain in `xbrief/active/` when `scope:complete` refuses empty `plan.acceptance.commands` without `none_stated` (#3284). That keeps the multi-active write fence red for unrelated work.

**Closeout:** `deft scope:complete -- <stale-brief> --merge-commit <sha> --pr <n> [--delivery-branch <branch>]`. Admission is repository-qualified delivery ancestry + linked PR (existing completion-provenance / #5105 machinery) that stamps `disposition: delivered`. Merge pointers alone, or `--non-delivery` with merge pointers, do not admit historical ship-closeout. `verify:completed-tracked` (#3476) is post-land DONE proof only — not an entry gate.

**Stage ladder (historical class):**

1. Stage 1 (#3284): empty commands migrate to `none_stated: true` only when merge provenance is present.
2. Stage 2 (#4870): Prefer-A binds the **clause-less** path (`acceptance.clauses` absent/empty). Clause-bearing empty-commands are refused with an honest remedy (not "stamp npm test" as the only path). Before that refusal, `scope:complete` runs the project's declared test command (`plan.policy.testCommand`, else `package.json` `scripts.test`) once as a transient floor through the ordinary acceptance walk; a green run completes with "declared test command passed" and writes nothing to the brief. With no declared command, a refused command or a failed run, the refusal names which, then lists each unresolved clause with the acceptance-disposition grant command (#7047).
3. Stage 3 (#3240 / #5105): with completion provenance present, merge-kind stamps may land on items missing `x-directive/requires: merge` (declaration-side admit). Strict axes (smoke/uat/deploy/observed_behavior) are not relabeled as merge.

**Fence unblock (local):** `deft scope:block -- <brief>` removes a competitor from eligibility without network. Multi-eligible deny also names `DEFT_ACTIVE_SCOPE`, keep-one-running, and the conditional closeout above. Softening #4007 for true concurrency is rejected.

**Deferred leftovers:** general `scope:park-active` for non-merged actives; unrecognized shell-form fence parity.

## Operator command: `scope:record-approved-scope` (legacy / authz-adjacent)

The verb remains for historical intent-pin minting and for `authz`-shared human-presence machinery. **It is not part of the proceed path** and is not the remediation for production-scope-over-budget (#4956). Prefer `deft scope:record-approved-scope` (consumer include-only: `task deft:scope:record-approved-scope`).

`--actor` is display only. Mint uses the shared #3110 human-presence gate (TTY, `--confirm`, typed phrase `mint` for that verb). Agent/CI env markers refuse.

## Working-tree / untracked files

`verify:scope-provenance` unions:

1. `git diff --name-only <base>...HEAD`
2. `git diff --name-only HEAD`
3. `git ls-files --others --exclude-standard`

and lists on-disk `xbrief/active/` files. Presence in the working tree is what matters for discovery. The **fence list** still comes from the merge-base brief bytes.

## Run time, phase lines and the per-call git limit (#6378)

The lifecycle census reads every brief under `xbrief/{pending,active,completed,cancelled}/` at the base ref. It lists each folder with `git ls-tree`, then reads the listed briefs with one `git cat-file --batch-check` and a few `git cat-file --batch` chunks. Each chunk stays under the subprocess buffer limit. A name that is not printable ASCII, an entry that is not a file, a brief too large for one chunk, and any batch fault use the single `git show` read as before. The verdict and the exit codes do not change. The texts the census read serve the later base reads of the same run. Nothing is kept between runs.

Before each phase (base resolution, change-set read, census with its brief count, per-story evaluation) the check writes one `verify_scope_provenance: phase: <name>` line to stderr. `--quiet` turns these lines off.

Every git call of the check has a time limit. The default is 120 seconds per call. `--git-timeout-seconds <n>` changes it, and `0` means no limit. `DEFT_SCOPE_PROVENANCE_GIT_TIMEOUT_SECONDS` sets it for runs that cannot pass the flag; the flag wins. At the limit the git process is ended with `SIGKILL`; git calls run with `GIT_OPTIONAL_LOCKS=0`. The limit ends the git process the check started, not a helper that git started (a credential helper, or a fetch in a partial clone).

The limit is the declared refusal `scope-provenance-git-call-timeout`. It ships in `warn` mode: a call that reaches the limit prints one line with the phase, the git command, the elapsed seconds and the remedy, and then runs once more with no limit. In `enforce` mode (a later release) the same line is the refusal and the check exits 2. The remedy is the verb with a larger `--git-timeout-seconds` value, for example `deft verify:scope-provenance --git-timeout-seconds 240`.

## Cohort proceed

On in-harness proceed for an N-story cohort: do not stop for scope. Land planner briefs (with `file_scope` when declared) on the base before workers branch. After proceed, schedule no scope ceremony — see `deft-directive-swarm` and the AGENTS managed pin (#4956).
