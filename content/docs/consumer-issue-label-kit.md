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

## Mirror (if using triage:classify -- --mirror)
- triaged
- optional action chips: triage:deferred, triage:archived
  (only if plan.policy.triageLabelMirror.actionLabels maps them)

Do not invent labels outside this file. Prefer existing names over twins.
```

! When creating issues, apply at least one appropriate label from the **existing** set.

---

## Optional: label mirror appendix

After SCM label mirror Waves 1–2 (#1423 / #3125):

| Topic | Guidance |
|-------|----------|
| Defaults | Mirror is available; on match it stamps **`triaged`** (idempotency). Action chips only when configured. |
| Dry-run | `deft triage:classify -- --mirror` (open-only default). Review the digest before `--apply`. |
| Apply | `deft triage:classify -- --mirror --apply` writes labels in batches; re-run is a no-op for already-`triaged` issues. |
| More matches | Add rules under `plan.policy.triageAutoClassify` in `xbrief/PROJECT-DEFINITION.xbrief.json`. |
| Richer chips | Set `plan.policy.triageLabelMirror.actionLabels` **and** create those GitHub labels first. |
| Accept path | ⊗ Never auto-`triage:accept` / never auto-write `proposed/` from mirror. Accept stays an operator decision. |

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

If you only want the default `triaged` stamp, you can omit `actionLabels` entirely.

Validate with:

```bash
deft triage:classify -- --validate
deft triage:classify -- --mirror
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
- Label mirror behavior: deposit `.deft/core/commands.md` (or framework `content/commands.md`) / `deft triage:classify -- --mirror` (#1423, #3125)
- Example PROJECT-DEFINITION triage fields: [`docs/example-project-definition.md`](https://github.com/deftai/directive/blob/master/docs/example-project-definition.md) (#1186; framework repo only, not deposited)
