# Observable UI scope (`verify:observable-scope`)

Refs: #4495 · Related: [scope-provenance.md](./scope-provenance.md) (#3145), [gate-integrity.md](./gate-integrity.md) (#3156), [#4503](https://github.com/deftai/directive/issues/4503), [#4586](https://github.com/deftai/directive/issues/4586)

First ship is **not** universal UI coverage. Applicability is opt-in and base-pinned.

## Contract

1. Commit `.deft/observable-ui.policy.json` on the merge base listing UI path globs (`schema: deft.observable-ui.policy.v1`). Inside a matched surface, an absent mint record fails. If UI file types (`.html` / `.jsx` / `.tsx`) change and no surfaces policy is set, the check emits a non-adoption finding and exits 0 (test-boundary inferred-defaults-warn). Non-UI and UI-free changes stay N/A.
2. Put the story contract on `plan["x-directive/observableChange"]` (not bare `plan.observableChange`).
3. Mint with `task scope:record-observable-scope -- <xbrief> --actor <you> --confirm` (#3110). Commit `.deft/observable-scope/<plan-id>.json` on the merge base **before** the UI-change PR. Same-PR rewrite fails. `--actor` is display-only. Missing mint is a preflight / dispatch refusal, not a same-run prompt.
4. `task verify:observable-scope` computes the merge base (no worker-declared `baselineRef`) and compares a versioned `parse5+typescript` oracle (`deft.observable-ui.v1`) for tabs, headings, controls, table columns, landmarks, and major containers. Closed file types: `.html` (parse5 with `scriptingEnabled: false`; no script engine, window, URL, or loader), `.jsx` / `.tsx` (TypeScript parse-only, resolved from the consumer project with a 5.x floor; no cwd default). HTML `template` elements inside `.html` are in scope. Undeclared dialects (vue/svelte/njk/hbs/ejs/astro) fail. Markup-visible `selected` / `aria-selected` / source-order is in scope. Runtime/state-derived default selection is #4503. Same-file `const [ident] = useState(<StringLiteral>)` with `value={ident}` emits `tab-selected` from the matching `TabsTrigger value=` literal (#4586). `TabsTrigger` as a tab tag, `defaultValue`, import-follow, and same-both-sides stay #4503. Exercised kinds are `fields-only` and `layout-authorized`. `mixed` is not a first-ship escape.

One remediation: restore the baseline markup structure or amend the observable scope through explicit human-presence mint (`scope:record-observable-scope`).

The verb is composed on `task check` (`FRAMEWORK_CHECK_GATES`, `CONSUMER_CHECK_GATES`, and required consumer enforcement). Missing, stale, invalid, or changed provider material fails; there is no generic fallback. Dependency delta versus master is two pure parser packages (`parse5` and `entities`). The JSX path trades a bundled pinned parser for one resolved from the consumer project, recorded per artifact and never compared against the mint. Truncated or incomplete HTML is refused (parse5 onParseError into anomalies). jsdom is not a dependency.

Three-state exit: `0` skip, warn-findings, or pass / `1` missing mint or unlisted delta / `2` invalid configuration.
