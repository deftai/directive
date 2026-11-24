# Observable UI scope (`verify:observable-scope`)

Refs: #4495, #4588 · Related: [scope-provenance.md](./scope-provenance.md) (#3145), [gate-integrity.md](./gate-integrity.md) (#3156), [#4503](https://github.com/deftai/directive/issues/4503), [#4586](https://github.com/deftai/directive/issues/4586)

First ship is **not** universal UI coverage. Applicability is opt-in and base-pinned.

## Contract

## When to mint (#4588)

Demand predicate the evaluator already implements:

- Verify (fail-closed): merge-base surfaces policy AND a matched `.html`/`.jsx`/`.tsx` change.
- Preflight: markup in `intended_placement.files`. Setup-created briefs with empty or missing placement are not this site.
- Greenfield without that policy is N/A (or inferred-defaults-warn on UI change), not an ask.

The when a durable grant can satisfy: after `plan["x-directive/observableChange"]` is authored on the xBRIEF, before the UI-change PR, and only if that predicate is true. That is a later operator-present moment than parking.

Sequence independently of parking: whenever a matched UI PR is about to exist under an adopted surfaces policy, write the declared record after the contract is on the brief (#7031). Parking is not this when. Predecessor #4383 is closed (superseded by #4988).

Do not "fix when" by tightening working-tree `existsSync` at preflight. Do not invent a shared digest with approved-scope, or an oracle change. Durable store stays merge-base JSON under `.deft/observable-scope/` with `humanApproval`; chat text is never the evaluate input (#5010).

1. Commit `.deft/observable-ui.policy.json` on the merge base listing UI path globs (`schema: deft.observable-ui.policy.v1`). Inside a matched surface, an absent mint record fails. If UI file types (`.html` / `.jsx` / `.tsx`) change and no surfaces policy is set, the check emits a non-adoption finding and exits 0 (test-boundary inferred-defaults-warn). Non-UI and UI-free changes stay N/A.
2. Put the story contract on `plan["x-directive/observableChange"]` (not bare `plan.observableChange`).
3. Collection UX (#7031): write the declaration. `scope:record-observable-scope` writes `.deft/observable-scope/<plan-id>.json` from any shell, an agent's included, with no terminal step and a declared stamp (`kind: "declared"`, `mintedVia: scope:record-observable-scope`); it refuses `--kind` and `--minted-via`, and `--actor` is an optional declared-by name. Commit that record on the delivery-branch merge base **before** the UI-change PR (a record PR, or the activation PR that adds its brief), then rebase the implementation branch onto it — same-PR working-tree-only records are not authoritative. Same-PR rewrite fails. For a cohort, pass several brief paths or `--manifest <launch-manifest>`; existing records are never overwritten, and the records may ride in the activation PR when each matches a brief that PR adds (#6937). A declaration is not consent: the merge that lands a record is its control, and only under `requireHumanMerge` does a person review it ([human-origin-authz.md](../contracts/human-origin-authz.md) § Operator mint inventory). Records with a legacy human stamp still parse; move the runtime pin to a release that reads declared records before writing one. At the signed level (#6945), with `.deft/approvers.json` on the merge base, pass `--request` (prints the ceremony link and writes nothing) or `--assertion <blob>`; a record without a valid approval is not approved, however it was merged. A valid approval proves a user-verified gesture by an enrolled authenticator over exactly this set. The human read it only if the page ran on a device the agent does not drive and was deployed with credentials the agent does not hold. Windows Hello, Touch ID, a desktop USB key and the desktop browser's cross-device QR are a lower review assurance than the phone's own browser. Removing the surfaces policy, editing CI, or pinning an older runtime turns the check off without forging an approval (#6207). An approval stays valid while its key stays enrolled. See [approvers.md](./approvers.md). The fail-closed missing-record site is verify merge-base, not a same-run prompt. An active UAT lease still refuses.
4. `task verify:observable-scope` computes the merge base (no worker-declared `baselineRef`) and compares a versioned `parse5+typescript` oracle (`deft.observable-ui.v1`) for tabs, headings, controls, table columns, landmarks, and major containers. Closed file types: `.html` (parse5 with `scriptingEnabled: false`; no script engine, window, URL, or loader), `.jsx` / `.tsx` (TypeScript parse-only, resolved from the consumer project with a 5.x floor; no cwd default). HTML `template` elements inside `.html` are in scope. Undeclared dialects (vue/svelte/njk/hbs/ejs/astro) fail. Markup-visible `selected` / `aria-selected` / source-order is in scope. Runtime/state-derived default selection is #4503. Same-file `const [ident] = useState(<StringLiteral>)` with `value={ident}` emits `tab-selected` from the matching `TabsTrigger value=` literal (#4586). Colliding same-file idents or TabsTrigger labels stay unresolvable. `TabsTrigger` as a tab tag, `defaultValue`, import-follow, and same-both-sides stay #4503. Exercised kinds are `fields-only` and `layout-authorized`. `mixed` is not a first-ship escape.

One remediation: restore the baseline markup structure, or write the declaration with `scope:record-observable-scope` and land the record on the merge base before the UI-change PR (commit on delivery branch, then rebase the implementation branch).

The verb is composed on `task check` (`FRAMEWORK_CHECK_GATES`, `CONSUMER_CHECK_GATES`, and required consumer enforcement). Missing, stale, invalid, or changed provider material fails; there is no generic fallback. Dependency delta versus master is two pure parser packages (`parse5` and `entities`). The JSX path trades a bundled pinned parser for one resolved from the consumer project, recorded per artifact and never compared against the mint. Truncated or incomplete HTML is refused (parse5 onParseError into anomalies). jsdom is not a dependency.

Three-state exit: `0` skip, warn-findings, or pass / `1` missing mint or unlisted delta / `2` invalid configuration.

### PR deft-story plan-id adoption (#5782)

Same demand-site adopter as `verify:intent-constraint`: on multi-running or multi-mint tips with unresolved plan-id, adopt the unique running `plan.id` for a sole distinct `deft-story: N` on the PR body. Explicit `--plan-id` and a valid `DEFT_ACTIVE_SCOPE` win. Empty/non-digit PR env is no-PR-context. When `DEFT_ACTIVE_SCOPE` is set but not a running xBRIEF **and** PR context is present, adoption is suppressed with a named refuse (pass `--plan-id` or clear the pin) — without PR context the tip fall-through is unchanged. REST null is config/exit 2. No YAML planId pre-export.

A `deft-story: N` mark asserts #4864 delivery bind and whole-story close at cohort finalize — only use it on the PR that completes #N. A sole `deft-story-part: N` line (#6316) also selects the plan id, for mint selection only; it never completes the story. Adoption does not change finalize bind semantics.
