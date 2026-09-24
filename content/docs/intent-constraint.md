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
7. Collection UX (#5010): attended harness → detect the hard fact and ask the human in the parent chat; on yes the **human** lands the same merge-base record on a real TTY with `mintedVia: in-harness-ask` (attestation is not an agent-shell bypass). Commit that record on the delivery-branch merge base first, then rebase the implementation branch onto it — same-PR working-tree-only records are not authoritative. Unattended / C1 / operator-gone → rewrite to a free pattern or park — do not ask an empty room and do not treat leave-harness TTY `scope:record-intent-constraint` as the primary path. The legacy verb may remain for repair when a human is on a real TTY. Parent-agent auto-approve is out of scope. Agent/CI markers still refuse.
8. Site ids are compact statement text, not source offsets. Inserting unrelated text above an existing site does not mint a new fact.
9. P2 (literal acceptance preservation) is not this first ship. The verb is not `semantic-*`.

Returned-failure / `{ ok:false }` / filter-without-hard-fact paths are already free in extract (no detect, no ask, no mint). Prefer returned failures over inventing new throw/abort/numeric-const facts.

One remediation (worker-facing at `task check`): `INTENT_CONSTRAINT_MISSING` — detect + in-harness ask / rewrite-park as primary; leave-harness TTY `scope:record-intent-constraint` is legacy repair only. After chat yes, the human lands on a real TTY; agent/CI shells still refuse. Commit on the merge base, then rebase the implementation branch. Tests and in-scope file paths are not authority. It is not a paste-ready mint inside the agent shell.

The verb is composed on `task check` (`FRAMEWORK_CHECK_GATES`, `CONSUMER_CHECK_GATES`, and required consumer enforcement).

Three-state exit: `0` skip or pass / `1` unapproved fact, missing mint, or same-PR rewrite / `2` invalid configuration.
