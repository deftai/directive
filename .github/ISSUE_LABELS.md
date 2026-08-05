# Issue label taxonomy (deftai/directive)

**Audience:** maintainers and agents working **in this repository only**.  
**Not** the portable consumer starter kit — that is **#2611** (implement after this catalog is stable).

**Source of truth:** this file. Platform labels, machine/mirror labels, facet rules, and twin decisions live here. Do not invent ad hoc labels outside this catalog for new work.

**Related:** #2609 (this taxonomy), #3128 (open-issue migration onto the scheme), #2611 (consumer kit), #1423 / #3118 / #3126 (SCM label mirror), #1789 / #690 (`area:*`), #886 (triage umbrella).

---

## Facet discipline

| Facet | Labels | Role |
|-------|--------|------|
| **Type** | `bug`, `enhancement`, `rfc`, `epic`, `documentation`, … | What kind of issue |
| **Area** | Prefer **`area:*`** forward (#1789) | Product surface; resolve legacy twins over time |
| **Platform** | `platform:windows`, `platform:macos`, `platform:linux` | OS-intrinsic only |
| **Status / role** | `status:blocked`, `status:tracker`, **`status:child`**, `status:superseded-pending`, … | Lifecycle / queue role |
| **Audience / ranking** | `urgent`, `adoption-blocker`, `agent-experience`, … | Earn keep; used sparingly |
| **Machine / mirror** | `triaged`, `triage:deferred`, `triage:archived`, `triage:lifecycle-linked`, `triage:needs-human` | Closed set; primary writer = mirror apply |

An issue may wear **multiple facets** (e.g. `enhancement` + `area:cli` + `status:child` + `platform:windows`).

---

## Type: when to apply `epic`

**Definition:** Apply **`epic`** only when this issue is a **multi-ship product initiative** — multiple independent or sequenced shippable units, and **this issue is the plan identity** for that product capability.

**Apply `epic` when ALL hold:**

1. Success needs **2+ shippable units by design** (waves / children / PRs over time) — not one story split into two tiny tasks.
2. Theme is **product/platform capability** (not a pure process grab-bag).
3. This issue **names** that initiative (children hang under it).
4. Close condition is "program done," not "one PR merged."

**Do NOT apply `epic` when:**

- One story / one PR (or one xBRIEF) would honestly finish it — use `enhancement` / `bug` / etc.
- Only a coordination/process board — prefer **`status:tracker`** without `epic` (e.g. mega-review boards).
- Issue is a **child** of a larger initiative — use **`status:child`**, never `epic`.
- "Has two children" alone is **not** sufficient (two chores are not an epic).

**Examples (directive):**

- **Yes:** multi-wave product programs (e.g. inter-run memory, 1.0 readiness, Product Insights, label-mirror program **#1423**).
- **No:** a single Wave story, discovery packaging, or a residual one-PR fix.

---

## Status: `status:tracker` vs `status:child`

| Label | Means | Not |
|-------|--------|-----|
| **`status:tracker`** | This issue is a **coordination home** (plan, waves, current-shape / child list) | "Product epic" by itself; "root of the repo" |
| **`status:child`** | This issue has a **parent** in the graph | "Which parent"; "leaf only" |

**Product multi-ship root:** usually **`epic` + `status:tracker`**.  
**Process board:** **`status:tracker`**, `epic` optional/discouraged.  
**Leaf story:** type + **`status:child`** if parented; type only if standalone.

### Nested trackers / trackers under epics

Trees are normal. **Do not encode depth** (no `tracker-l2`).

**Allow mid-nodes to wear both** `status:tracker` and `status:child` (coordinates **and** has a parent):

```text
#886  status:tracker                    (process board)
  └─ #1423  epic + status:tracker + status:child
        └─ #3125  status:child + enhancement   one story → one PR
```

| Pattern | Labels on mid/root |
|---------|-------------------|
| Root product epic | `epic` + `status:tracker` |
| Nested product epic | `epic` + `status:tracker` + `status:child` |
| Nested thin wave tracker | `status:tracker` + `status:child` (no `epic`) |
| Leaf | `status:child` + type |
| Standalone story | type only |

**Mutually exclusive:** do **not** put `epic` on pure children.  
**Filters:** leaves ≈ `status:child` without `status:tracker`; nested trackers ≈ both status labels. Structure and parent id still come from **links + current-shape**, not labels alone.

---

## PR ↔ one story

- Prefer **one issue ↔ one story ↔ one PR**.
- Epic/tracker stays open across many PRs; **each child** closes with its PR.
- Epics are **not** the PR unit.

---

## Machine / mirror labels

Closed set. Mirror apply (`task triage:classify -- --mirror` / `--apply`) is the **primary writer**. Humans may add/remove for repair; do not invent new `triage:*` names outside this table.

| Label | Role |
|-------|------|
| `triaged` | Idempotency — classify/mirror already ran |
| `triage:deferred` | Suggested / applied `actionLabels.defer` |
| `triage:archived` | Suggested / applied `actionLabels.archive` |
| `triage:lifecycle-linked` | Suggested / applied `actionLabels.accept` |
| `triage:needs-human` | Suggested / applied `actionLabels.escalate` |

Do **not** overload human labels (`hold`, `rfc`, …) via `actionLabels`. Consumer kits (**#2611**) may ship a **subset** of this machine set.

Config surface: `plan.policy.triageLabelMirror` (see #1423 Wave 1 / #3118).

---

## Platform facet

| Label | When |
|-------|------|
| `platform:windows` | Bug or work is **intrinsic** to Windows (encoding, paths, PS, installers on win32) |
| `platform:macos` | Intrinsic to macOS |
| `platform:linux` | Intrinsic to Linux |

Do **not** use platform labels for "I happened to repro on Windows." Multi-platform bugs get multiple platform labels only when the failure mode is OS-specific on each.

Open-issue seed backfill is **#3128** (migration), not Phase A.

---

## Area facet (`area:*`)

Forward convention (**#1789** / **#690**): prefer `area:*` over legacy unprefixed twins.

| Keep (forward) | Prefer over |
|----------------|-------------|
| `area:cli` | ad-hoc CLI tags |
| `area:guidance` | — |
| `area:installer` | bare `installer` (legacy twin) |
| `area:release` | bare `release` when meaning surface (see twin table) |
| `area:skills` | bare `skills` (legacy twin) |
| `area:vbrief` | — |

New surfaces: add `area:<slug>` here first, then create the label with a description.

---

## Twin decisions (legacy → forward)

Migration of open issues is **#3128**. Phase A **decides** which name wins.

| Keep | Deprecate / avoid new use | Notes |
|------|---------------------------|--------|
| `documentation` | `docs` | Prefer `documentation` for human docs work |
| `area:skills` | `skills` | Surface facet |
| `area:installer` | `installer` | Surface facet |
| `enhancement` | inventing `feat` as a type label | Type facet uses `enhancement` |
| `rfc` | dual-stacking `type:research` without need | `type:research` OK for investigation; `rfc` for design discussion |
| `UPGRADE ANNOUNCEMENT` | typo `UPGRADE ANNOUCEMENT` | Renamed; typo form must not return |
| Machine set above | inventing extra `triage:*` | Closed set |

Empty-description labels should gain short descriptions when touched; do not delete legacy twins in Phase A (removal/alias cleanup is migration judgment on **#3128**).

---

## Catalog snapshot (Phase A)

Inventory ~85 labels at #2609 implement time. This section lists **canonical** names by facet. Full live list: `gh label list --repo deftai/directive`.

### Type (selected)

`bug`, `enhancement`, `rfc`, `epic`, `documentation`, `duplicate`, `invalid`, `wontfix`, `question`, `chore`, `refactor`, `type:research`

### Area

`area:cli`, `area:guidance`, `area:installer`, `area:release`, `area:skills`, `area:vbrief`

### Platform (created Phase A)

`platform:windows`, `platform:macos`, `platform:linux`

### Status / role

`status:blocked`, `status:tracker`, `status:child`, `status:superseded-pending`, `hold`, `fixed-pending-merge`

### Machine / mirror (created or confirmed Phase A)

`triaged`, `triage:deferred`, `triage:archived`, `triage:lifecycle-linked`, `triage:needs-human`

### Ranking / audience (selected)

`urgent`, `adoption-blocker`, `agent-experience`, `blocks-merge`, `blocks-release-tag`, `Upgrade Blocker`

### Process / workflow (selected)

`process` (if present), `Workflow`, `triage`, `swarm`, `meta`, `scm`, `determinism`, `source-of-truth`, …

---

## Agent rules (this repo)

1. ! Before applying labels, read this file (or the issue body of #2609 if this file is missing on an old branch).
2. ! Prefer existing catalog names; ⊗ invent new facet prefixes without amending this file.
3. ! For multi-ship product roots: `epic` + `status:tracker` when both definitions hold.
4. ! For parented leaves: `status:child` + type; ⊗ `epic` on pure children.
5. ! Machine labels: closed set above; mirror is primary writer.
6. ! Platform only for OS-intrinsic work.
7. ~ Consumer projects: follow **#2611** kit when shipped — do not copy the full maintainer set by default.

Skill / SCM pointer: `content/scm/github.md` § Issue Labels (framework source) links here.

---

## Non-goals (Phase A)

- Full-backlog auto-relabel (see **#3128**)
- Fail-closed unlabeled creates
- Consumer kit packaging (**#2611**) or discovery packaging (**#3124**)
- Encoding parent id as `child-of-N` labels
- Depth labels for nested trackers

---

## Changelog of this document

| Date | Change |
|------|--------|
| 2026-08-05 | Initial catalog from #2609 Phase A (facets, epic/tracker/child, machine, platform, twins) |
