# Intent constraint snapshot (`verify:intent-constraint`)

Refs: #4541 · Related: [scope-provenance.md](./scope-provenance.md) (#3145), [gate-integrity.md](./gate-integrity.md) (#3156), [observable-scope.md](./observable-scope.md) (#4495)

First ship is a merge-base snapshot of throw/reject/abort sites and new numeric consts in changed production files. File scope answers where. Tests answer whether the implementation matches assertions. This gate answers whether a new hard constraint or rejection site was approved.

## Contract

1. Closed file types: production `.ts` / `.js`. Tests are not in the snapshot and are not authority.
2. Closed fact kinds: `throw-site`, `reject-site`, `abort-site`, `numeric-const`.
3. Numeric-const peel is a while-unwrap of `AsExpression` (any asserted type), `SatisfiesExpression`, unary `+`/`-`, `ParenthesizedExpression`, and angle-bracket `TypeAssertion` until `NumericLiteral`. Do not `forEachChild`-harvest `NumericLiteral` (`Number(1024)`, `{ max: 1024 }`). Do not treat a numeric literal anywhere in an if-condition as a hard constraint.
4. Same-file helper extract of a posted throw plus same-file const is in the snapshot. Cross-file composition is a recorded first-ship miss.
5. Leftover is skip/filter/return-error that add neither a new numeric-const nor a throw/reject/abort site. Skip plus a new numeric const is not leftover.
6. Human-authored mint for `value`, `unit`, and `rejectionScope` via `task scope:record-intent-constraint -- <xbrief> --actor <you> --confirm`. Commit `.deft/intent-constraint/<plan-id>.json` on the merge base before the implementation PR. Authority read is `git show <merge-base>` only. Same-PR rewrite fails.
7. P2 (literal acceptance preservation) is not this first ship. The verb is not `semantic-*`.

One remediation: `INTENT_CONSTRAINT_MISSING: Link the hard constraint and rejection scope to a base-approved requirement or decision, or remove the behavior. Tests and in-scope file paths are not authority.`

The verb is composed on `task check` (`FRAMEWORK_CHECK_GATES`, `CONSUMER_CHECK_GATES`, and required consumer enforcement).

Three-state exit: `0` skip or pass / `1` unapproved fact, missing mint, or same-PR rewrite / `2` invalid configuration.
