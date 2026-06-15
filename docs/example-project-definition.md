# Example PROJECT-DEFINITION: consumer policy config (#1186)
This document is the canonical reference example for `vbrief/PROJECT-DEFINITION.vbrief.json` `plan.policy.*` configuration under the framework primitives shipped by umbrella #1119: auto-classification (D10 / #1129), ranking labels (D11 / #1128), subscription scope (D12 / #1131), scope-drift ignore-list (D14 / #1133 + D14c / #1182), and the WIP cap (D4 / #1124).
Per umbrella #1119 Current Shape v3 section 12 (framework-vs-consumer boundary) the framework defaults are deliberately consumer-agnostic. The values below are deft's own operator choices, shipped here so future consumers can clone-and-edit confidently. Other consumers will substitute their own labels, milestones, and ranking weights.
## 1. Empty template
Every field below is consumer-agnostic. Omit a field entirely to accept the framework default; the framework never bakes deft-specific labels into its defaults.
```json path=null start=null
{
  "plan": {
    "policy": {
      "triageScope": [],
      "triageRankingLabels": [],
      "triageAutoClassify": [],
      "triageScopeIgnores": [],
      "wipCap": 10
    }
  }
}
```
Framework defaults when each field is unset:
- `triageScope[]` -- defaults to `[{"rule": "all-open"}]` (every open issue in the cached repo is in scope). D12 / #1131 Decision 5.
- `triageRankingLabels[]` -- defaults to empty; queue ordering is `updated_at` descending within group. D11 / #1128.
- `triageAutoClassify[]` -- defaults to empty; only the four hardcoded framework universal rules fire (hold-marker / closed-never-triaged / dormant-thin-body / vbrief-referenced). D10 / #1129 Decision 1+2.
- `triageScopeIgnores[]` -- defaults to empty; every drift signal surfaces until the operator opts out. D14 / #1133.
- `wipCap` -- defaults to 10 (the framework constant `DEFAULT_WIP_CAP`). D4 / #1124.
## 2. Deft's filled-in version
The values below are what deft itself ships on `vbrief/PROJECT-DEFINITION.vbrief.json` after this PR lands. They reflect deft's actual label vocabulary and operator preferences; substitute with your own when adopting.
```json path=null start=null
{
  "plan": {
    "policy": {
      "triageScope": [
        {
          "rule": "labels",
          "any-of": [
            "enhancement",
            "epic",
            "meta",
            "skills",
            "adoption-blocker",
            "blocks-merge",
            "blocks-release-tag",
            "bug"
          ]
        },
        {"rule": "milestone", "is-open": true}
      ],
      "triageRankingLabels": [
        "blocks-merge",
        "blocks-release-tag",
        "adoption-blocker",
        "breaking-change",
        "urgent",
        "bug"
      ],
      "triageAutoClassify": [
        {
          "match": {"labels": {"any-of": ["status:superseded-pending"]}},
          "action": "defer",
          "reason": "awaiting umbrella deliverable"
        },
        {
          "match": {"labels": {"any-of": ["rfc", "type:research"]}},
          "action": "defer",
          "reason": "exploratory"
        },
        {
          "match": {"labels": {"any-of": ["wontfix"]}},
          "action": "defer",
          "reason": "wontfix"
        },
        {
          "match": {"labels": {"any-of": ["duplicate"]}},
          "action": "archive",
          "reason": "duplicate -- already tracked elsewhere"
        },
        {
          "match": {"labels": {"any-of": ["fixed-pending-merge"]}},
          "action": "defer",
          "reason": "auto-close on linked PR merge",
          "resume-on": "<linked-PR>:merged"
        }
      ],
      "triageScopeIgnores": [
        {"label": "wontfix"},
        {"label": "duplicate"}
      ]
    }
  }
}
```
Note on `wipCap`: deft accepts the framework default 10, so the field is omitted from deft's PROJECT-DEFINITION entirely. Set it explicitly only when your consumer wants a different cap.
Note on the `triageScopeIgnores` shape: D14c / #1182 supports two ignore-entry shapes -- the single-key form `{label: <name>}` or `{milestone: <name>}` and the rule-shaped form `{rule: "author", any-of: [...]}` for author-based ignores. Per-label ignores use one entry per label (no compact `{rule: "labels", any-of: [...]}` shape exists today; that would require a framework extension).
## 3. Side-by-side annotation column
For each non-empty value, this column explains whether it is deft-specific (your repo would substitute its own) or a common convention (works for most repos that follow the umbrella).
### triageScope[]
- `labels.any-of [enhancement, epic, meta, skills, adoption-blocker, blocks-merge, blocks-release-tag, bug]` -- mixed:
  - `enhancement`, `epic`, `meta`, `skills` -- common convention. Most GitHub repos using a similar labelling hygiene will recognise these as the high-signal buckets (`enhancement` is a GitHub default, `epic` / `meta` / `skills` are commonly used as cross-cutting tags).
  - `adoption-blocker` -- common convention (mid-tier adoption tracking; substitute with your own onboarding-friction label).
  - `blocks-merge` -- deft-specific. Deft uses this label to gate merges on cohort-level reviews; your repo may not have this concept. If your repo uses a different gating label (`blocking`, `priority:p0`, `release-blocker`, ...) substitute it here.
  - `blocks-release-tag` -- deft-specific. Deft uses this label to surface issues that must clear before a release tag cuts; substitute with your own release-gating label or omit.
  - `bug` -- common convention. Subscribing to `bug` keeps open defects in the triage cache so they can be ranked; it pairs with the `bug` ranking label below (a ranking label only takes effect on issues that are in scope). `bug` is a GitHub default label; substitute with `defect` / `regression` as your repo uses.
- `milestone.is-open: true` -- common convention. Once D14b / #1181 landed this rule type subscribes to every currently-open upstream milestone at sync time. Most consumers benefit from this -- if you maintain milestones at all, the currently-open set is naturally your active-work envelope.
### triageRankingLabels[]
Highest-priority first; matched labels rank within their group ahead of unmatched ones, with `updated_at` desc as the tiebreaker.
- `blocks-merge` -- deft-specific (same as in `triageScope[]` above).
- `blocks-release-tag` -- deft-specific.
- `adoption-blocker` -- common convention.
- `breaking-change` -- common convention. Works for most repos that follow Conventional Commits or any semantic-versioning discipline; signal is "a release containing this needs operator attention before it ships".
- `urgent` -- common convention. Many repos use `urgent` / `priority:high` / `p0`; substitute with whichever label your team uses for "drop everything".
- `bug` -- common convention. Ranked last among the priority labels so the explicit escalation labels above still win, but a `bug`-labelled issue still ranks ahead of the large mass of unlabelled / feature / RFC work. `bug` is a GitHub default label; substitute with `defect` / `regression` / whichever label your team uses for "something is broken".
### triageAutoClassify[]
First-match-wins after the four framework universal rules.
- `{labels.any-of [status:superseded-pending], action: defer, reason: awaiting umbrella deliverable}` -- deft-specific. Deft uses `status:superseded-pending` for child issues whose work is folded into a larger umbrella deliverable; deferring keeps them out of the active queue without losing the audit trail. If your repo does not have an umbrella-driven planning model, omit this rule or substitute with your own deferred-by-design label.
- `{labels.any-of [rfc, type:research], action: defer, reason: exploratory}` -- common convention. Most repos eventually accumulate a tail of exploratory issues that are not actively being worked; deferring exploratory work is a near-universal pattern. Substitute label names to match your repo's vocabulary.
- `{labels.any-of [wontfix], action: defer, reason: wontfix}` -- common convention. `wontfix` is a GitHub default label; the auto-defer keeps wontfix items off the active queue while preserving the audit history (an operator can still walk wontfix decisions later via `task triage:audit`).
- `{labels.any-of [duplicate], action: archive, reason: duplicate -- already tracked elsewhere}` -- common convention. `duplicate` is a GitHub default label. `archive` (rather than `defer`) is the canonical action because a duplicate has no separate state to resume.
- `{labels.any-of [fixed-pending-merge], action: defer, reason: auto-close on linked PR merge, resume-on: <linked-PR>:merged}` -- deft-specific labelling, common convention pattern. Deft uses `fixed-pending-merge` to indicate a fix is in a PR awaiting merge; the `resume-on` clause (D3 / #1123 grammar) auto-promotes the issue back to the queue when the linked PR merges. Substitute label name to match your repo; the `resume-on` pattern is portable.
### triageScopeIgnores[]
Suppresses signals from drift detection (D14 / #1133) without preventing the items from being matched in triageScope. The two entries below mirror the auto-classify rules above -- `wontfix` and `duplicate` are already handled by the auto-classify rules, so the drift detector should not surface them as "new label" signals.
- `{label: wontfix}` -- common convention.
- `{label: duplicate}` -- common convention.
## 4. Closing note: clone-and-edit
To adapt this example to your repo:
1. Copy the relevant `plan.policy.*` fields into your project's `vbrief/PROJECT-DEFINITION.vbrief.json`.
2. Adjust label names to match your repo's vocabulary (search-and-replace `blocks-merge`, `blocks-release-tag`, `adoption-blocker`, `status:superseded-pending`, `fixed-pending-merge` first -- those are the deft-specific entries).
3. Re-rank `triageRankingLabels[]` to reflect your priorities.
4. Drop or rewrite any rule that does not match a label your repo uses (the framework treats absent labels as no-match, so leftover deft-specific rules are harmless but noisy).
5. Run `task vbrief:validate` to confirm the resulting PROJECT-DEFINITION passes every framework primitive's schema validator.
6. Run `task triage:bootstrap` against your real label set; walk the resulting cache via `task triage:queue --limit=10` and `task triage:audit` to sanity-check that the rules fire as expected.
Cross-references:
- Umbrella: [#1119](https://github.com/deftai/directive/issues/1119) (Current Shape v3 section 12 framework-vs-consumer boundary)
- Framework primitives consumed: [#1129](https://github.com/deftai/directive/issues/1129) (D10 auto-classify), [#1128](https://github.com/deftai/directive/issues/1128) (D11 ranking labels), [#1131](https://github.com/deftai/directive/issues/1131) (D12 subscription scope), [#1182](https://github.com/deftai/directive/issues/1182) (D14c ignore-list + author rule), [#1133](https://github.com/deftai/directive/issues/1133) (D14 ignore-list foundation), [#1124](https://github.com/deftai/directive/issues/1124) (D4 wipCap; deft accepts framework default 10)
- Consumer-example child: [#1186](https://github.com/deftai/directive/issues/1186)
