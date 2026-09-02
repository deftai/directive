# Consumer issue-label kit

**Audience:** consumer projects that use Directive (not the `deftai/directive` maintainer repo).  
**Status:** recommended starter set -- not a mandate.  
**Related:** [#2611](https://github.com/deftai/directive/issues/2611) (this kit) · [#2609](https://github.com/deftai/directive/issues/2609) (maintainer taxonomy only) · [#3124](https://github.com/deftai/directive/issues/3124) (session discovery tips) · [#1423](https://github.com/deftai/directive/issues/1423) (SCM label mirror)

Directive agents label issues from the **repo's existing** label set. They must not invent labels. This guide ships a **thin portable kit** so capacity and triage matchers have something real to use.

⊗ Import the full `deftai/directive` maintainer catalog (dozens of facets such as `ts-migration`, `swarm`, `area:vbrief`, full `patterns:*`). That catalog is maintainer-only ([`.github/ISSUE_LABELS.md`](https://github.com/deftai/directive/blob/master/.github/ISSUE_LABELS.md) / #2609).

---

## Recommended kit

Create these labels in your forge (GitHub/GitLab/etc.) when you adopt Directive, or when your backlog is bare. Prefer existing project names when you already have equivalents (`defect` for `bug`, a single docs label for `documentation`).

### Core (always recommend)

| Label | Role |
|-------|------|
| `bug` | Defect / incorrect behavior |
| `enhancement` | New capability or improvement |
| `documentation` | Docs-only work |
| `duplicate` | Already tracked elsewhere |
| `wontfix` | Declined / out of scope |

Optional priority: `urgent` (or your project's priority label).

### Role (if you run multi-issue programs)

| Label | Role |
|-------|------|
| `epic` | Multi-ship **product** initiative root (rare) |
| `status:tracker` | Long-lived coordination home (plan / children), not one PR |
| `status:child` | Has a parent -- not a root queue item |

### Triage / mirror (if you use Directive triage + label mirror)

| Label | Role |
|-------|------|
| `triaged` | Machine idempotency -- classify/mirror already ran (**include if you recommend mirror**) |
| `triage` | Optional human "area of work" chip (not a machine `triage:*` label) |

Optional action chips (only if you set `plan.policy.triageLabelMirror.actionLabels`). Use the **same names** as the maintainer machine set -- do not invent a second vocabulary:

| Label | Typical `actionLabels` key |
|-------|----------------------------|
| `triage:deferred` | `defer` |
| `triage:archived` | `archive` |

Richer chips (`triage:lifecycle-linked`, `triage:needs-human`) exist in the maintainer set; adopt them only when your policy maps those actions.

### Optional project routing

Not part of Core always-recommend. Create on the forge **only if your project uses the path**, then document the name in the consumer catalog (for example `.github/ISSUE_LABELS.md`) so agents do not invent labels outside the catalog.

| Label | Role |
|-------|------|
| `security` | Marks security-axis issues/PRs for **advisory** security review routing when the project has that path (for example a Security Officer or security-review checklist). |

- ⊗ Treat `security` as a merge gate or as a substitute for review bots (Greptile / SLizard / host security-review).
- ⊗ Import maintainer-only AppSec facet trees or the full maintainer security taxonomy -- this kit stays portable and thin (#2609 boundary; #3007 is a different surface).

---

## Story / PR (MUST)

- Prefer **one issue ≈ one story ≈ one PR**.
- Do **not** open an "epic" for two tiny checklist tasks.
- Epic/tracker issues stay open across many PRs; **each child** closes with its PR.
- Epics are **not** the PR unit.

---

## When to use `epic` (short rule)

Apply **`epic` only** when this issue is a **multi-ship product initiative**: multiple shippable units by design, and this issue is the program home.

**Not** "has two children." Children are normal stories with optional **`status:child`**, never `epic`.

| Situation | Labels |
|-----------|--------|
| Product multi-ship root | `epic` + `status:tracker` |
| Process / coordination board | `status:tracker` (epic optional / discouraged) |
| Leaf under a parent | type label + optional `status:child` |
| Standalone one-PR story | type label only |

Parent identity lives in **links** (and current-shape / body text), not in labels. Nested mid-trackers may wear both `status:tracker` and `status:child`. Do not invent depth labels (`tracker-l2`, …).

---

## Document your labels

~ Keep a short project catalog so agents and humans share one vocabulary. A common pattern is `.github/ISSUE_LABELS.md` in the **consumer** repo (name is a convention; any stable path works if AGENTS.md or CONTRIBUTING points at it).

Example stub:

```markdown
# Issue labels (this repo)

Recommended starter set from Deft Directive consumer kit:
https://github.com/deftai/directive/blob/master/content/docs/consumer-issue-label-kit.md

## Core
- bug, enhancement, documentation, duplicate, wontfix
- optional: urgent

## Role (multi-issue programs)
- epic (rare multi-ship product root)
- status:tracker, status:child

## Mirror (withdrawn #4070)
- `triage:classify -- --mirror` is withdrawn. Do not stamp `triaged` / `triage:*` from classify.
- Replacement sieve is #4071. Leave these names unused until the replacement recuts the catalog.

## Optional project routing (only if used)
- security (advisory security review routing; not a merge gate)

Do not invent labels outside this file. Prefer existing names over twins.
```

! When creating issues, apply at least one appropriate label from the **existing** set.

---

## Optional: label mirror appendix

After #4070, SCM label mirror Waves 1–2 (#1423 / #3125) are unusable. `deft triage:classify -- --mirror` (dry-run and `--apply`) fail closed. Strip leftover chips with `deft triage:strip-withdrawn-chips`. Replacement sieve is #4071. #2611 stays open. Accept stays an operator decision (`triage:accept` / ingest unchanged).

Minimal policy sketch (clone and edit; broader triage field examples live in the framework repo at [`docs/example-project-definition.md`](https://github.com/deftai/directive/blob/master/docs/example-project-definition.md) — not deposited under `.deft/core/`):

```json
{
  "plan": {
    "policy": {
      "triageAutoClassify": [
        {
          "match": { "labels": { "any-of": ["wontfix"] } },
          "action": "defer",
          "reason": "wontfix"
        },
        {
          "match": { "labels": { "any-of": ["duplicate"] } },
          "action": "archive",
          "reason": "duplicate"
        }
      ],
      "triageLabelMirror": {
        "actionLabels": {
          "defer": ["triage:deferred"],
          "archive": ["triage:archived"]
        }
      }
    }
  }
}
```

`triage:classify -- --mirror` is withdrawn (#4070). Do not add `triageLabelMirror` to stamp `triaged` / `triage:*`. Validate remaining classify rules with:

```bash
deft triage:classify -- --validate
```

---

## Capacity and ranking

Labels only help ranking and auto-classify when they **exist** on the forge and appear on issues. After the kit is created:

- Point `plan.policy.triageRankingLabels` at labels you care about first (for example `urgent`, `bug`).
- Point `plan.policy.triageScope` at the open-work envelope you want in cache.
- Run `deft triage:welcome` (or your host's triage onboarding) so subscription and WIP policy match the kit.

---

## What not to copy from directive

Do **not** treat the maintainer catalog as a consumer default. Examples of maintainer-only names:

- `ts-migration`, `swarm`, `area:vbrief`, full `patterns:*` trees
- Large `area:*` / platform / process zoos built for the framework monorepo
- `legacy:*` quarantine names (closed history only on the framework repo)

Name alignment for the thin shared set (`bug`, `enhancement`, `documentation`, `epic`, `status:tracker`, `status:child`, `triaged`, optional `triage:*` action chips) follows **#2609** so mirror and classify stay portable. Full facet depth stays maintainer-only.

---

## Discovery

Installed deposit (consumer tree):

| Surface | Path after deposit |
|---------|-------------------|
| This doc | `.deft/core/docs/consumer-issue-label-kit.md` |
| SCM guide | `.deft/core/scm/github.md` (section Issue Labels) |
| Getting started | `.deft/core/docs/getting-started.md` (backlog section) |

Framework source / GitHub (browse when not in a deposit):

| Surface | URL / path |
|---------|------------|
| This doc | [`content/docs/consumer-issue-label-kit.md`](https://github.com/deftai/directive/blob/master/content/docs/consumer-issue-label-kit.md) |
| Session tip packaging | **#3124** (after this kit) |

---

## Related reading

- Maintainer taxonomy (do not import wholesale): [`.github/ISSUE_LABELS.md`](https://github.com/deftai/directive/blob/master/.github/ISSUE_LABELS.md) (#2609)
- Label mirror withdrawn: deposit `.deft/core/commands.md` (or framework `content/commands.md`) / #4070 (do not run `deft triage:classify -- --mirror`)
- Example PROJECT-DEFINITION triage fields: [`docs/example-project-definition.md`](https://github.com/deftai/directive/blob/master/docs/example-project-definition.md) (#1186; framework repo only, not deposited)
