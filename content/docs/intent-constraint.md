# Intent constraint snapshot (`verify:intent-constraint`)

Refs: #4541 · Related: [scope-provenance.md](./scope-provenance.md) (#3145), [gate-integrity.md](./gate-integrity.md) (#3156), [observable-scope.md](./observable-scope.md) (#4495)

First ship is a merge-base snapshot of throw/reject/abort sites and new numeric consts in changed production files. File scope answers where. Tests answer whether the implementation matches assertions. This gate answers whether a new hard constraint or rejection site was approved.

## Contract

1. Closed file types: production `.ts` / `.js`. Tests are not in the snapshot and are not authority.
2. Closed fact kinds: `throw-site`, `reject-site`, `abort-site`, `numeric-const`.
3. Numeric-const peel is a while-unwrap of `AsExpression` (any asserted type), `SatisfiesExpression`, unary `+`/`-`, `ParenthesizedExpression`, and angle-bracket `TypeAssertion` until `NumericLiteral`. Do not `forEachChild`-harvest `NumericLiteral` (`Number(1024)`, `{ max: 1024 }`). Do not treat a numeric literal anywhere in an if-condition as a hard constraint.
4. Same-file helper extract of a posted throw plus same-file const is in the snapshot. Cross-file composition is a recorded first-ship miss.
5. Leftover is skip/filter/return-error that add neither a new numeric-const nor a throw/reject/abort site. Skip plus a new numeric const is not leftover.
6. Durable authority is still the merge-base JSON under `.deft/intent-constraint/<plan-id>.json`. Its `humanApproval` is a declared stamp (`kind: "declared"`, `mintedVia: scope:record-intent-constraint`, #7031) or a legacy human stamp; a declared record is a declaration the check holds the PR to, not an approval, and `isHumanApprovalStamp` never accepts it. Author `plan["x-directive/intentConstraint"]` when `value` / `unit` / `rejectionScope` already exist, before the implementation PR that introduces the facts -- not at record-approved-scope. File-scope can be named at allocation. Throw values usually cannot. Authority read is `git show <merge-base>` only. Same-PR rewrite fails. Multiple merge-base mints require `--plan-id`, `DEFT_ACTIVE_SCOPE`, dest unique running xBRIEF, or demand-site PR `deft-story: N` adoption (#5782). Each mint row covers at most one new numeric-const of that value and at most one new throw/reject/abort site. Do not invent a second snapshot or fill speculative value/unit/rejectionScope so a mint succeeds at park. Chat text is never the evaluate input.

### PR deft-story plan-id adoption (#5782)

On multi-running or multi-mint tips, when plan-id is unresolved, the gate may adopt the running brief `plan.id` owned by a sole distinct `deft-story: N` mark on the PR body (`GITHUB_PR_NUMBER` or `--pr`, plus `GITHUB_REPOSITORY` / `--repo`). Empty or non-digit PR env is no-PR-context (master push / local check keep dest-unique-running). REST null is config/exit 2. Sole means exactly one distinct issue number after dedupe (duplicate identical lines are sole). Unparseable mark values (including plan-id shaped strings) refuse. Explicit `--plan-id` and a valid `DEFT_ACTIVE_SCOPE` still win.

A `deft-story: N` mark asserts #4864 delivery bind (`metadata.productPullRequest` must equal this PR before leftover finalize). Satisfying that bind closes the whole story at cohort finalize (stamp path is mark-independent). Only put the mark on the PR that completes #N. Adoption is a multi-active tiebreak; it does not alter finalize-cohort bind semantics and is not an override of sole-running.

A sole `deft-story-part: N` line (#6316) is accepted the same way, for mint selection only: it marks a product PR that is part of story N and does not complete it, and it is never a finalize close signal. Both lines for one N in one body refuse.
7. Collection UX (#5574 Prefer-A / #7031): classify the condition, not the API name. Expected operational deny → returned-failure / filter (free). Invariant / corruption / impossible-if-healthy → fail-fast throw (or language-equivalent) + a declared record; rewrite solely to clear the gate is forbidden. To write the declaration, run `scope:record-intent-constraint` from any shell, an agent's included: there is no terminal step, it writes `kind: "declared"` naming the command, and it refuses `--kind` and `--minted-via`; `--actor` is an optional declared-by name. Land the record on the delivery-branch merge base before the product PR (a record PR, or the activation PR that adds its brief), then rebase the implementation branch onto it — same-PR working-tree-only records are not authoritative. A fact found mid-build still needs that record PR first. A declaration is not consent: under `requireHumanMerge` the person who merges the record PR reviews it; under bot merge or a merge under the operator's identity nothing human checks it (see [human-origin-authz.md](../contracts/human-origin-authz.md) § Operator mint inventory). For a cohort, pass several brief paths or `--manifest <launch-manifest>`; existing records are never overwritten, and the records may ride in the activation PR when each matches a brief that PR adds (#6937). An active UAT lease still refuses. Records with a legacy human stamp (`mintedVia: in-harness-ask` included) still parse. Move the runtime pin to a release that reads declared records before writing one: an older runtime fails the whole record folder on a record it cannot parse. At the signed level (#6945), with `.deft/approvers.json` on the merge base, pass `--request` (writes nothing) or `--assertion <blob>`; a record without a valid approval is not approved, however it was merged. A valid approval proves a user-verified gesture by an enrolled authenticator over exactly this set. The human read it only if the page ran on a device the agent does not drive and was deployed with credentials the agent does not hold. See [approvers.md](./approvers.md). Numeric-const and the four `FACT_KINDS` still need a record; a free rewrite introduces none of them. Language-equivalent fail-fast guidance does not imply new panic/assert extraction beyond production TS/JS.
8. Site ids are compact statement text, not source offsets. Inserting unrelated text above an existing site does not mint a new fact.
9. P2 (literal acceptance preservation) is not this first ship. The verb is not `semantic-*`.

### Failure-handling split (#5574 Prefer-A)

Classify the condition, not the API name. Closed cues:

| Class | Cues | Handling |
|-------|------|----------|
| Operational | expected deny / caller-may-retry / lock-busy / missing grant | returned-failure / `{ ok:false }` / filter (free; no record) |
| Invariant | store corruption / impossible-if-healthy under the lock or admission invariant / programmer-error after validation | fail-fast throw (or language-equivalent; SHOULD, not a blanket language-independent MUST) + declared intent-constraint record |

Cite #5542 admission throws as the positive invariant class. Do not weaken the `verify:intent-constraint` record check.

Paired worked example (exclusive-create / admission under lock):

- Missing grant or ordinary lock contention → returned denial. Caller may retry or obtain a grant; soft failure is safe.
- The same exclusive-create / admission path after validation under the relevant lock, when an invariant is violated (corrupt binding, impossible-if-healthy race the lock was supposed to forbid) → fail-fast + declared record landed on the merge base → rebase. Retry is unsafe because the world is not healthy; softening to `{ ok:false }` would teach callers to treat corruption as a transient deny.

One remediation (worker-facing at `task check`): `INTENT_CONSTRAINT_MISSING` — ordered Prefer-A: operational → returned-failure/filter free; invariant or any remaining new hard fact among the four `FACT_KINDS` (including `numeric-const` on an otherwise operational path) → write the declaration with `scope:record-intent-constraint` and land it on the merge base before the product PR (rewrite solely to clear the gate is forbidden). Commit on the merge base, then rebase the implementation branch. A declaration is not consent. Tests and in-scope file paths are not authority.

The verb is composed on `task check` (`FRAMEWORK_CHECK_GATES`, `CONSUMER_CHECK_GATES`, and required consumer enforcement).

Three-state exit: `0` skip or pass / `1` undeclared fact, missing record, or same-PR rewrite / `2` invalid configuration.
