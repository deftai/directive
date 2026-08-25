# Issue label taxonomy (deftai/directive)

**Audience:** maintainers and agents working **in this repository only**.  
**Not** the portable consumer starter kit — that lives in [`content/docs/consumer-issue-label-kit.md`](../content/docs/consumer-issue-label-kit.md) (**#2611**).

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

Do **not** overload human labels (`hold`, `rfc`, …) via `actionLabels`. Consumer kits ([`content/docs/consumer-issue-label-kit.md`](../content/docs/consumer-issue-label-kit.md) / **#2611**) may ship a **subset** of this machine set.

Config surface: `plan.policy.triageLabelMirror` (see #1423 Wave 1 / #3118).

### Design-critique stamp (ADR-005 / #3434 / #3627 / #3642 / #3640)

Author-stamped, not classify-mirror output. Not a `triage:*` classify action. The triage author decides the lean is mechanism-shaped and writes **both** halves of the #1423 pairing. After synthesis-accepted (operator **accept synthesis** or #3640 auto-stamp), apply the bind-ready chip as the exclusive catalog chip.

Closed set (one current chip; remaining-set replace, last chip wins):

| Surface | Value | Role |
|---------|-------|------|
| Body-text field (artifact) | `mechanism-shaped: true` | Survives in the write-back comment; history after remaining-set replace |
| Mirrored label (predicate / lists) | `design-critique:mechanism-shaped` | In-flight; what `plan.policy.judgmentGates` matches |
| Synthesis-accepted line | `design-critique: synthesis accepted, because …` | Bind record (operator **accept synthesis** or #3640 auto-stamp) |
| Bind-ready label | `design-critique:triage-ready` | Bound; remaining-set replace after synthesis-accepted |

Applying one catalog chip: parent MUST call `task scm:issue:design-critique-chip -- --issue N --chip triage-ready|mechanism-shaped [--repo OWNER/NAME]`. GET current labels, drop the other catalog names (`design-critique:mechanism-shaped` and `design-critique:triage-ready`), PUT/PATCH that remaining set. Other facets stay. Inventory: `LabelClient.apply` / `mergeIssueLabels`. Do not DELETE-then-POST (unchipped window). Do not PUT a naive full wipe. Do not `gh api POST .../labels` or additive `scm:issue:edit --add-label`.

Chip is list state, not consent. Do not drop `mechanism-shaped` without the synthesis-accepted line (or the #3640 empty-disagreement path).

Do **not** invent a classifier for "mechanism-shaped." Stamp or omit. No stamp -> gate never fires (voluntary critiques stay legal). Clearance line is separate: `design-critique: warranted \| not warranted, because ...` (ADR-005).

Critic does not write issue labels. Do not add a critic-posted or author/role chip. `judgmentGates` still matches only `design-critique:mechanism-shaped`. No halt chip. Remove-set is those two catalog names only.

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

Migration of open issues is **#3128**. Phase A **decides** which name wins. Zero-open legacy twins and dead synonyms are **quarantined by rename** (not delete) so closed history keeps a searchable tag.

### Quarantine policy (`legacy:*`)

| Rule | Detail |
|------|--------|
| **Name form** | All **lowercase**: `legacy:<former-name>` (exact former string after the colon) |
| **Colon wins** | When a colon facet and a non-colon twin both exist, **keep the `:` form** (newer/forward); quarantine the older non-colon name when open count is 0 |
| **Neither colon** | Keep the catalog forward name (e.g. `documentation`); quarantine the other (e.g. `legacy:docs`) |
| **Do not quarantine** | Machine set (`triaged`, `triage:*`), platform reserve, gates, standard disposition (`duplicate` / `wontfix` / `invalid`), support upgrade labels |
| **Agent rule** | ⊗ Apply any `legacy:*` label on new work |

### Live forward → quarantined (applied when open count was 0)

| Keep (forward) | Quarantined label (was) |
|----------------|-------------------------|
| `documentation` | `legacy:docs` |
| `area:skills` | `legacy:skills` |
| `area:installer` | `legacy:installer` |
| `area:release` | `legacy:release` |
| `scm` / `ci-cd` | `legacy:github`, `legacy:github-actions` |
| `ci-cd` / area surfaces | `legacy:packaging` |
| `test-debt` / evals / harness | `legacy:testing` |
| *(unused GH defaults)* | `legacy:help wanted`, `legacy:question` |

| Keep | Deprecate / avoid new use | Notes |
|------|---------------------------|--------|
| `documentation` | bare `docs` (now `legacy:docs`) | Prefer `documentation` for human docs work |
| `area:skills` | bare `skills` (now `legacy:skills`) | Surface facet |
| `area:installer` | bare `installer` (now `legacy:installer`) | Surface facet |
| `area:release` | bare `release` (now `legacy:release`) | Surface facet |
| `enhancement` | inventing `feat` as a type label | Type facet uses `enhancement` |
| `rfc` | dual-stacking `type:research` without need | `type:research` OK for investigation; `rfc` for design discussion |
| `UPGRADE ANNOUNCEMENT` | typo `UPGRADE ANNOUCEMENT` | Renamed; typo form must not return |
| Machine set above | inventing extra `triage:*` | Closed set |

Empty-description labels should gain short descriptions when touched.

---

## Catalog snapshot (Phase A)

Inventory ~85 labels at #2609 implement time. This section lists **canonical** names by facet. Full live list: `gh label list --repo deftai/directive`.

### Type (selected)

`bug`, `enhancement`, `rfc`, `epic`, `documentation`, `duplicate`, `invalid`, `wontfix`, `chore`, `refactor`, `type:research`  
*(do not use `legacy:question` on new work)*

### Area

`area:cli`, `area:guidance`, `area:installer`, `area:release`, `area:skills`, `area:vbrief`

### Platform (created Phase A)

`platform:windows`, `platform:macos`, `platform:linux`

### Status / role

`status:blocked`, `status:tracker`, `status:child`, `status:superseded-pending`, `hold`, `fixed-pending-merge`

### Machine / mirror (created or confirmed Phase A)

`triaged`, `triage:deferred`, `triage:archived`, `triage:lifecycle-linked`, `triage:needs-human`

### Design-critique stamp (ADR-005 / #3627)

`design-critique:mechanism-shaped` -- author stamp that the lean is mechanism-shaped; pairs with write-back field `mechanism-shaped: true`. Not a `triage:*` classify action.

`design-critique:triage-ready` -- attach after synthesis-accepted (operator **accept synthesis** or #3640 auto-stamp); pairs with `design-critique: synthesis accepted, because …`. Not a `triage:*` classify action.

### Ranking / audience (selected)

`urgent`, `adoption-blocker`, `agent-experience`, `blocks-merge`, `blocks-release-tag`, `Upgrade Blocker`

#### `adoption-blocker` -- canonical consumer hard-blocker (#3650)

**Positive-only:** this label means the issue is *classified as a blocker*. Its absence means *not classified* -- never that a workaround exists.

**Definition:** a Directive consumer cannot complete an intended flow without a reasonable workaround. The range is install, first session, update, `task check`, and ship -- not first session alone.

**GitHub description (100-char cap):** `Consumer cannot complete an intended Directive flow; no reasonable workaround`

**Required evidence:** body must name affected consumer flow and version; documented alternatives attempted, or why the documented alternatives are not a reasonable workaround; observed recovery cost; and triage owner and date. Full test: `content/scm/github.md` Issue Workflow.

**Ranking / display (verified, not newly built):** already in `plan.policy.triageRankingLabels` after `blocks-merge` and `blocks-release-tag`. `triage:queue` prints `(label: adoption-blocker)` on ranked rows. Do not add ranking code.

**Title classification (the one sanctioned exception, #3713):** `BLOCKER` in the title is permitted for this consumer hard-stop class, and is the **only** classification allowed in an issue title. Every other classification stays label-only. Reason: the filing population cannot apply labels -- GitHub requires push access to set them at issue creation, and labels are silently dropped otherwise. The title token is the inbound flare so a maintainer scanning a list can see the report; it does not apply `adoption-blocker`. A privileged actor applies the ranking label after the body-evidence test. Absence of the token does not mean "not a blocker." ⊗ Auto-mirror a consumer-authored title into `adoption-blocker`.

**Distinguished from adjacent signals:**

| Label | Means | Not `adoption-blocker` because |
|---|---|---|
| `Upgrade Blocker` | Blocks the user from upgrading | Upgrade facet only. A hard stop at `task check` or ship is not this. |
| `status:blocked` | *This* issue waits on something else | Lifecycle of the issue, not "consumer cannot complete an intended flow". |
| `urgent` | High priority; ranks above `bug` | Priority, not hard-stop. An issue may be `urgent` and still not a blocker (this recut of #3650 is the example). |

**Upgrade overlap:** when the stuck flow is upgrade, apply both. `adoption-blocker` is the ranking chip; `Upgrade Blocker` is the upgrade facet. `Upgrade Blocker` alone does not rank.

**Choice recorded:** broaden `adoption-blocker` rather than add a new slug. Onboarding-specific wording did not need preserving -- historical use already stretched past first session, and a second label would split the same class. Relabel of existing `BLOCKER`-titled issues is #3699, not this story.

### Process / workflow (selected)

`process` (if present), `Workflow`, `triage`, `swarm`, `meta`, `scm`, `determinism`, `source-of-truth`, …

---

## Agent rules (this repo)

1. ! Before applying labels, read this file (or the issue body of #2609 if this file is missing on an old branch).
2. ! Prefer existing catalog names; ⊗ invent new facet prefixes without amending this file.
3. ! Prefer colon facet forms (`area:*`, `status:*`, `platform:*`, `triage:*`) over non-colon twins.
4. ⊗ Apply any `legacy:*` label; those are closed-history quarantine only.
5. ! For multi-ship product roots: `epic` + `status:tracker` when both definitions hold.
6. ! For parented leaves: `status:child` + type; ⊗ `epic` on pure children.
7. ! Machine labels: closed set above; mirror is primary writer.
8. ! Platform only for OS-intrinsic work.
9. ~ Consumer projects: follow **#2611** kit when shipped — do not copy the full maintainer set by default.
10. ! Consumer hard-stop uses `adoption-blocker`, with body evidence (`content/scm/github.md` Issue Workflow); an upgrade-path hard stop also uses `Upgrade Blocker`. ⊗ Infer that a workaround exists from the label's absence. ? Encode `BLOCKER` in the issue title for this class only -- the filing population cannot apply labels (GitHub requires push access at issue creation). `BLOCKER` is the only permitted title classification; every other classification stays label-only. ⊗ Encode any other classification in the issue title. ⊗ Auto-mirror title text to `adoption-blocker`. Absence of the token does not mean "not a blocker."

Skill / SCM pointer: `content/scm/github.md` § Issue Labels (framework source) links here.

---

## Non-goals (Phase A)

- Full-backlog auto-relabel (see **#3128**)
- Fail-closed unlabeled creates
- Consumer kit packaging (**#2611**) or discovery packaging (**#3124**)
- Encoding parent id as `child-of-N` labels
- Depth labels for nested trackers

---

## Open-issue migration (#3128)

**When:** after this catalog is stable (post-#2609 Phase A).  
**What:** retag **open** issues only (closed history not rewritten).

### How it was run

1. Dry-run then apply the one-shot script:

   ```text
   node .github/scripts/migrate-issue-labels-3128.mjs --dry-run
   node .github/scripts/migrate-issue-labels-3128.mjs --apply
   ```

2. Report artifact: `.github/ISSUE_LABEL_MIGRATION_3128.json` (mode, twin/role counts, per-issue before/after).

### What the script does

| Pass | Action |
|------|--------|
| **Twins** | Open issues: `docs` → `documentation`, `skills` → `area:skills`, `installer` → `area:installer` (other labels preserved) |
| **Roles (curated)** | Graph-informed set only (process board #886 → `status:tracker` without `epic`; product multi-ship roots → `epic`+`status:tracker`; known children → `status:child`; nested #1423 → epic+tracker+child) |
| **Platform seeds** | `#412`, `#1422` → `platform:windows` |
| **Machine mirror** | **Not** run by the script — optional separate `task triage:classify -- --mirror --apply` (open-only) |

### False-positive policy

- Skip unknown parents rather than invent `status:child` from title keywords.
- Do not use mirror apply to invent `epic` / `status:child`.
- Re-run is safe (idempotent adds; twin remove only when deprecated label still present).

### Re-run / extend

- Edit `ROLE_SCOPE` in the script for additional curated role stamps, then `--dry-run` / `--apply`.
- Twin renames follow the twin table in this file; add rows there before extending the script.

## Changelog of this document

| Date | Change |
|------|--------|
| 2026-08-24 | Broaden `adoption-blocker` to the full intended-flow range; state positive-only semantics; distinguish from `Upgrade Blocker`, `status:blocked`, and `urgent` (#3650) |
| 2026-08-21 | Design-critique stamp label `design-critique:mechanism-shaped` + write-back field `mechanism-shaped: true` (ADR-005 / #3434 Story 1) |
| 2026-08-05 | Quarantine zero-open twins/synonyms as lowercase `legacy:<former>` (colon form wins) |
| 2026-08-05 | Open-issue migration notes + re-run instructions (#3128) |
| 2026-08-05 | Initial catalog from #2609 Phase A (facets, epic/tracker/child, machine, platform, twins) |
