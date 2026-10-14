# Intent constraint snapshot (`verify:intent-constraint`)

Refs: #4541 · Related: [scope-provenance.md](./scope-provenance.md) (#3145), [gate-integrity.md](./gate-integrity.md) (#3156), [observable-scope.md](./observable-scope.md) (#4495)

First ship is a merge-base snapshot of throw/reject/abort sites and new numeric consts in changed production files. File scope answers where. Tests answer whether the implementation matches assertions. This gate answers whether a new hard constraint or rejection site was approved.

## Contract

1. Closed file types: production `.ts` / `.js`. Tests are not in the snapshot and are not authority.
2. Closed fact kinds: `throw-site`, `reject-site`, `abort-site`, `numeric-const`.
3. Numeric-const peel is a while-unwrap of `AsExpression` (any asserted type), `SatisfiesExpression`, unary `+`/`-`, `ParenthesizedExpression`, and angle-bracket `TypeAssertion` until `NumericLiteral`. Do not `forEachChild`-harvest `NumericLiteral` (`Number(1024)`, `{ max: 1024 }`). Do not treat a numeric literal anywhere in an if-condition as a hard constraint.
4. Same-file helper extract of a posted throw plus same-file const is in the snapshot. Cross-file composition is a recorded first-ship miss.
5. Leftover is skip/filter/return-error that add neither a new numeric-const nor a throw/reject/abort site. Skip plus a new numeric const is not leftover.
6. Durable authority is still the merge-base JSON under `.deft/intent-constraint/<plan-id>.json` with `humanApproval` (`isHumanApprovalStamp`). Author `plan["x-directive/intentConstraint"]` when `value` / `unit` / `rejectionScope` already exist, before the implementation PR that introduces the facts -- not at record-approved-scope. File-scope can be named at allocation. Throw values usually cannot. Authority read is `git show <merge-base>` only. Same-PR rewrite fails. Multiple merge-base mints require `--plan-id`, `DEFT_ACTIVE_SCOPE`, or dest unique running xBRIEF. Each mint row covers at most one new numeric-const of that value and at most one new throw/reject/abort site. Do not invent a second snapshot or fill speculative value/unit/rejectionScope so a mint succeeds at park. Chat text is never the evaluate input.
7. Collection UX (#5010 / #5574 Prefer-A): classify the condition, not the API name. Expected operational deny → returned-failure / filter (free). Invariant / corruption / impossible-if-healthy → fail-fast throw (or language-equivalent) + attended mint; rewrite solely to clear the gate is forbidden. Attended harness → detect the hard fact and ask the human in the parent chat; on yes the **human** lands the same merge-base record on a real TTY with `mintedVia: in-harness-ask` (attestation is not an agent-shell bypass). Commit that record on the delivery-branch merge base first, then rebase the implementation branch onto it — same-PR working-tree-only records are not authoritative. Unattended / C1 / operator-gone → operational may rewrite or park; invariant requiring a new hard fact must park pending a human mint — do not ask an empty room and do not treat leave-harness TTY `scope:record-intent-constraint` as the primary path. The legacy verb may remain for repair when a human is on a real TTY. Parent-agent auto-approve is out of scope. Agent/CI markers still refuse. Numeric-const and the four `FACT_KINDS` stay on the human decision / park path; a free rewrite introduces none of them. Language-equivalent fail-fast guidance does not imply new panic/assert extraction beyond production TS/JS.
8. Site ids are compact statement text, not source offsets. Inserting unrelated text above an existing site does not mint a new fact.
9. P2 (literal acceptance preservation) is not this first ship. The verb is not `semantic-*`.

### Failure-handling split (#5574 Prefer-A)

Classify the condition, not the API name. Closed cues:

| Class | Cues | Handling |
|-------|------|----------|
| Operational | expected deny / caller-may-retry / lock-busy / missing grant | returned-failure / `{ ok:false }` / filter (free; no mint) |
| Invariant | store corruption / impossible-if-healthy under the lock or admission invariant / programmer-error after validation | fail-fast throw (or language-equivalent; SHOULD, not a blanket language-independent MUST) + attended intent-constraint mint |

Cite #5542 admission throws as the positive invariant class. Do not weaken `verify:intent-constraint` `humanApproval`.

Paired worked example (exclusive-create / admission under lock):

- Missing grant or ordinary lock contention → returned denial. Caller may retry or obtain a grant; soft failure is safe.
- The same exclusive-create / admission path after validation under the relevant lock, when an invariant is violated (corrupt binding, impossible-if-healthy race the lock was supposed to forbid) → fail-fast + human ask → human merge-base mint → rebase, or park unattended. Retry is unsafe because the world is not healthy; softening to `{ ok:false }` would teach callers to treat corruption as a transient deny.

One remediation (worker-facing at `task check`): `INTENT_CONSTRAINT_MISSING` — ordered Prefer-A: operational → returned-failure/filter free; attended invariant or any remaining new hard fact among the four `FACT_KINDS` (including `numeric-const` on an otherwise operational path) → ask + mint (rewrite solely to clear the gate is forbidden); unattended hard fact → park pending a human mint. Leave-harness TTY `scope:record-intent-constraint` is legacy repair only. After chat yes, the human lands on a real TTY; agent/CI shells still refuse. Commit on the merge base, then rebase the implementation branch. Tests and in-scope file paths are not authority. It is not a paste-ready mint inside the agent shell.

The verb is composed on `task check` (`FRAMEWORK_CHECK_GATES`, `CONSUMER_CHECK_GATES`, and required consumer enforcement).

Three-state exit: `0` skip or pass / `1` unapproved fact, missing mint, or same-PR rewrite / `2` invalid configuration.
