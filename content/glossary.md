# Glossary

The authoritative vocabulary for the Deft framework.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

! When a term used in any directive file is not locally defined, load this file to resolve it.
! When introducing a new term in any directive file, define it here first.
⊗ Define the same term differently in two files — one definition, one source of truth.

---

## Deft Work Decomposition Hierarchy

```
Release          ← Shippable version (one or more features)
  └── Feature    ← Independently demo-able vertical capability
       └── Task  ← Context-window-sized unit of work
```

**Release** — A shippable version of the product. Contains one or more features. Maps to a git tag and a CHANGELOG entry. See [versioning.md](./meta/versioning.md).

**Feature** — An independently demo-able vertical capability. Scoped by a **demo sentence**: "After this, the user can ___." If you can't fill in that blank with something a human can observe, the feature is scoped wrong. Features are vertical (user-visible) not horizontal ("implement the database layer").

**Task** — The atomic unit of work. Must fit in one agent context window. If it doesn't fit, it's two tasks. This is an iron rule — violating it is where agents lose coherence.

---

## Terms Introduced by Deft (with GSD lineage)

These concepts originate from [GSD](https://github.com/gsd-build/get-shit-done) and have been adapted into the Deft framework.

**Anchor pruning** — Giving each task a fresh context window by pruning prior tasks' tool calls, intermediate reads, and debugging traces. Eliminates context rot. See [resilience/context-pruning.md](./resilience/context-pruning.md).

**Context rot** — The silent degradation of agent reasoning quality as the context window fills with stale tool output, dead-end debugging, and outdated file reads from prior tasks. By task 3–4 in a sequence, signal-to-noise has collapsed.

**Decision locking** — Decisions made during the discuss/interview phase are recorded in a context file and treated as **locked** for all downstream work. Downstream tasks inherit them — they don't re-debate. See [strategies/discuss.md](./strategies/discuss.md).

**Demo sentence** — The scoping test for a feature: "After this, the user can ___." If the blank can't be filled with something a human can observe, the feature is scoped wrong.

**Fractal summaries** — Hierarchical memory compression: task summaries compress into feature summaries, which compress into release summaries. Iron rule: never summarize summaries — regenerate each level from the level below + code state. See [context/fractal-summaries.md](./context/fractal-summaries.md).

**Specification vbrief** — The source-of-truth pattern for project intent. `./vbrief/specification.vbrief.json` is the canonical specification file; `SPECIFICATION.md` is a generated artifact rendered from it. The spec vbrief is created via interview (`templates/make-spec.md`), reviewed by the user, approved (`status: approved`), then rendered. Never edit the `.md` directly — edit the source vbrief. See [vbrief/vbrief.md](./vbrief/vbrief.md).

**Stub detection** — Scanning completed code for incomplete implementations: `TODO`/`FIXME` markers, `return null`/`return {}`/`pass` placeholders, functions under ~8 lines returning hardcoded values. See [verification/verification.md](./verification/verification.md).

**Verification ladder** — A 4-tier model for verifying agent work, picking the strongest tier reachable: (1) Static — files exist, exports present, no stubs. (2) Command — tests pass, build succeeds. (3) Behavioral — flows work, APIs respond correctly. (4) Human — manual verification only when tiers 1–3 can't confirm. See [verification/verification.md](./verification/verification.md).

**Zero discovery calls** — The principle that agents should never spend tokens figuring out where they are, what exists, or what was decided. All of that should be pre-assembled in context before the task starts. See [resilience/context-pruning.md](./resilience/context-pruning.md).

**Brownfield mapping** — Structured reconnaissance of an existing codebase before modifying it. Produces four artifacts: STACK (languages, frameworks, infrastructure), ARCHITECTURE (layers, entry points, data flow), CONVENTIONS (naming, patterns, file layout), and CONCERNS (tech debt, fragile areas, missing tests). See [strategies/map.md](./strategies/map.md). Invoked via `/deft:run:map`.

**Integration checking** — Cross-feature wiring verification that every export has a matching import, every API endpoint has a consumer, auth gates protect all required routes, and at least one E2E flow traces through the full stack. See [verification/integration.md](./verification/integration.md).

**Plan checking** — Pre-execution verification of a plan across four dimensions: (1) coverage — every acceptance criterion maps to at least one task, (2) completeness — every task has a verify command, (3) wiring — cross-feature dependencies declared in boundary maps, (4) scope — task count within sanity thresholds (2–3 ideal, 5+ requires split). See [verification/plan-checking.md](./verification/plan-checking.md).

**Scope sanity** — A threshold-based guard against over-scoped plans that degrade context window quality. 1–3 tasks per plan is ideal; 4 is a warning; 5+ is a blocker requiring plan split. Part of plan checking dimension 4. See [verification/plan-checking.md](./verification/plan-checking.md).

**Spec delta** — A scoped document capturing how a change modifies existing requirements. Shows new requirements and was/now diffs for modified ones. Linked to the baseline spec via vBRIEF `references` with `type: "x-vbrief/plan"`. Lives in `history/changes/<name>/specs/`. See [context/spec-deltas.md](./context/spec-deltas.md). Invoked as part of `/deft:change`.

**Verify command** — A concrete, runnable command specified per task that confirms the task's work is correct (e.g., `pytest tests/test_auth.py`, `curl localhost:8080/health`). Required by plan checking dimension 2 (completeness). Tasks without a verify command fail the plan check.

---

## Framework Design Terms

Terms describing how directive itself is structured and governed.

**Bounded context** (framework sense) — A file or directory in directive that owns a specific rule domain. Other files reference it; they do not restate its rules. Prevents rule drift through duplication. Examples: `coding/hygiene.md` owns hygiene rules; `coding/testing.md` owns universal testing standards.

**Rule ownership** — The principle that each concept in directive has exactly one owning file. When multiple files need to reference the concept, they link to the owner rather than duplicating the rule.

**Ubiquitous language** — The shared, precisely defined vocabulary used consistently across all directive files and by all agents. This glossary is the source of truth. Synonyms and informal restatements of defined terms are not permitted.

---

## Hygiene Terms

Terms used in [coding/hygiene.md](./coding/hygiene.md).

**Hygiene** — The ongoing practice of keeping a codebase clean beyond what individual changes introduce: removing dead code, eliminating circular dependencies, surfacing hidden errors, and removing legacy/deprecated code paths. Distinct from per-change quality gates, which only govern new code.

**Dead code** — Code that is defined but never executed: unused functions, unreachable branches, stale feature flags, and commented-out blocks. Distinct from deprecated code, which may still execute on a legacy path.

**Error hiding** — Any pattern that prevents an error from being observed by the caller or operator: empty catch blocks, silent fallbacks, returning neutral/zero values to mask failures, or log-and-continue without surfacing the error upstream.

**Legacy code** — A code path, implementation, or feature flag that has been superseded but not removed. Identified by markers such as `LEGACY`, `COMPAT`, `OLD_`, `TODO: remove`, or the presence of two parallel implementations without a migration path.

**Circular dependency** — An import cycle where module A depends on module B which depends (directly or transitively) on module A. Indicates architectural coupling that prevents modular testing and signals a layering violation.

---

## GSD → Deft Term Mapping

For readers familiar with [GSD](https://github.com/gsd-build/get-shit-done):

| GSD Term | Deft Term | Notes |
|----------|-----------|-------|
| Milestone | **Release** | Shippable version |
| Slice | **Feature** | Vertical capability with demo sentence |
| Task | **Task** | Same — add "fits in one context window" |
| Must-haves | **Acceptance criteria** | With subcategories: truths, artifacts, key links |
| Continue file | **Continue checkpoint** | `./vbrief/continue.vbrief.json` (singular) |
| Discuss phase | **Interview** (extended) | Adds decision locking + Feynman technique |
| Boundary map | **Contract** (at planning level) | Extension of Contract-First |
| Wave execution | **Parallel group** | Speckit `[P]`/`[S]` markers |
| Research phase | **Research** | Already in speckit |

---

## vBRIEF Lifecycle Terms (v0.20+)

Canonical vocabulary for the vBRIEF lifecycle. (Merged from the former top-level `glossary.md` during the #1875 content/ move; deduplicated to a single canonical glossary.)

- **Scope vBRIEF** -- A durable unit-of-work record, one per feature / bug / initiative, stored as `YYYY-MM-DD-slug.vbrief.json` inside a [lifecycle folder](#terms). Scope vBRIEFs are the primary work artifact in v0.20 (see [vbrief/vbrief.md -- Scope vBRIEFs and Lifecycle Folders](./vbrief/vbrief.md#scope-vbriefs-and-lifecycle-folders)).

- **Lifecycle folder** -- One of the five subdirectories under `vbrief/`: `proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`. Folder location reflects (but does not define) `plan.status`; see [vbrief/vbrief.md -- Directory Structure](./vbrief/vbrief.md#directory-structure) and [Status-Driven Moves](./vbrief/vbrief.md#status-driven-moves).

- **Plan-level narrative** -- A key under `plan.narratives` in a vBRIEF file, describing the scope/plan as a whole (e.g. `Description`, `Acceptance`, `Traces`). Plan-level narratives describe the *what and why*; see [vbrief/vbrief.md -- Narratives](./vbrief/vbrief.md#narratives).

- **Item-level narrative** -- A narrative string under `plan.items[].narrative` describing a single `PlanItem` (a task / subtask within a scope). Both plan-level and item-level narratives MUST be plain strings -- never objects (see [vbrief/vbrief.md -- Narratives](./vbrief/vbrief.md#narratives)).

- **Filename stem** -- The portion of a vBRIEF filename before `.vbrief.json`. For scope vBRIEFs the stem follows `YYYY-MM-DD-<slug>`; for speckit Phase 4 emissions the stem is `YYYY-MM-DD-ip<NNN>-<slug>` with `NNN` zero-padded to 3 digits (see [vbrief/vbrief.md -- Filename Convention](./vbrief/vbrief.md#filename-convention)).

- **Cross-scope dependency** -- A dependency between two scope vBRIEFs (rather than between items inside a single scope). Cross-scope dependencies live at `plan.metadata.dependencies` as an array of dependency IDs -- plan-level by design (see [vbrief/vbrief.md -- Plan-level metadata](./vbrief/vbrief.md#plan-level-metadata)).

- **Exit Commands** -- The seven deterministic `task scope:*` commands that transition a scope vBRIEF between lifecycle folders: `scope:promote`, `scope:activate`, `scope:complete`, `scope:cancel`, `scope:restore`, `scope:block`, `scope:unblock` (see [tasks/scope.yml](../tasks/scope.yml)). Agents MUST use these instead of moving files by hand.

- **Origin provenance** -- A `references` entry on a scope vBRIEF linking back to the issue / ticket / user-request that spawned it (`type: github-issue`, `jira-ticket`, or `user-request`). Required for ingestion dedup; see [vbrief/vbrief.md -- Origin Provenance](./vbrief/vbrief.md#origin-provenance).

- **Canonical narrative key** -- One of the small set of reserved plan-level narrative keys (`Description`, `Acceptance`, `Traces`) that tooling (`task roadmap:render`, swarm allocator) reads by name. See [vbrief/vbrief.md -- Scope vBRIEF narrative keys](./vbrief/vbrief.md#scope-vbrief-narrative-keys).

- **Preparatory strategy** -- A [strategies/](./strategies/) workflow that gathers context without producing a spec directly (e.g. `research.md`, `discuss.md`, `map.md`, `bdd.md`). Preparatory strategies chain into a [spec-generating strategy](#terms).

- **Spec-generating strategy** -- A [strategies/](./strategies/) workflow that emits `vbrief/specification.vbrief.json` (and optionally scope vBRIEFs) as its authoritative output (e.g. `interview.md`, `speckit.md`, `enterprise.md`, `rapid.md`, `yolo.md`).

- **Rendered export** -- A human-readable `.md` file (`SPECIFICATION.md`, `PRD.md`, `ROADMAP.md`) generated on demand by a `task *:render` command from the underlying `.vbrief.json` file. Rendered exports are read-only views; direct edits are overwritten on the next render (see [UPGRADING.md -- What to expect](./UPGRADING.md#what-to-expect)).

- **Source of truth** -- The file that tooling treats as authoritative for a given piece of information. In v0.20 the `.vbrief.json` files are the source of truth; the corresponding `.md` files are [rendered exports](#terms). Editing a rendered export does not change the source of truth -- edit the `.vbrief.json` instead.

- **Deterministic mode** -- The interaction shape used by every Deft skill that asks the user structured questions (via `ask_user_question` single-select / multi-select) or numbered-menu prompts in skill prose. Every deterministic-mode prompt MUST include `Discuss` and `Back` as the final two numbered options (#767). The canonical rule and verbatim Discuss-pause semantic live at [`contracts/deterministic-questions.md`](./contracts/deterministic-questions.md); skill prose `!` cross-references that contract instead of duplicating the rule body.

- **Branch-protection policy** -- The Deft policy surface that controls whether direct commits to the default branch (master/main) are allowed. The typed flag is `plan.policy.allowDirectCommitsToMaster` on `vbrief/PROJECT-DEFINITION.vbrief.json` (#746); default `false` (enforce feature branches). Three enforcement surfaces back the policy: skill-level guards at the entry of `deft-directive-{swarm,review-cycle,pre-pr,release}` (#746 part C), the detection-bound `scripts/preflight_branch.py` reachable via `task verify:branch` and the `.githooks/pre-commit` + `.githooks/pre-push` hooks (#747), and the CI `branch-gate` workflow asserting `head_ref != base_ref` (#747 part E). Reconfigure via `task policy:show` / `task policy:enforce-branches` / `task policy:allow-direct-commits -- --confirm`. Emergency bypass: `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`.

- **Policy audit log** -- One-line append-only ledger at `meta/policy-changes.log` recording every transition of `plan.policy.allowDirectCommitsToMaster`. Written by `scripts/policy_set.py` whenever `task policy:enforce-branches` or `task policy:allow-direct-commits -- --confirm` is invoked, including the actor, previous value, and any operator-supplied `--note`. Surface introduced by #746 acceptance criterion G2.
