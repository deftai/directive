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

**Specification xbrief** — The source-of-truth pattern for project intent. `./xbrief/specification.xbrief.json` is the canonical specification file; `SPECIFICATION.md` is a generated artifact rendered from it. Never edit the `.md` directly — edit the source xbrief. See [vbrief/vbrief.md](./vbrief/vbrief.md) (schema reference; public name is xBRIEF).

**Stub detection** — Scanning completed code for incomplete implementations: `TODO`/`FIXME` markers, `return null`/`return {}`/`pass` placeholders, functions under ~8 lines returning hardcoded values. See [verification/verification.md](./verification/verification.md).

**Verification ladder** — A 4-tier model for verifying agent work, picking the strongest tier reachable: (1) Static — files exist, exports present, no stubs. (2) Command — tests pass, build succeeds. (3) Behavioral — flows work, APIs respond correctly. (4) Human — manual verification only when tiers 1–3 can't confirm. See [verification/verification.md](./verification/verification.md).

**Zero discovery calls** — The principle that agents should never spend tokens figuring out where they are, what exists, or what was decided. All of that should be pre-assembled in context before the task starts. See [resilience/context-pruning.md](./resilience/context-pruning.md).

**Brownfield mapping** — Structured reconnaissance of an existing codebase before modifying it. Produces four artifacts: STACK, ARCHITECTURE, CONVENTIONS, and CONCERNS. See [strategies/map.md](./strategies/map.md). Invoked via `/deft:run:map`.

**Integration checking** — Cross-feature wiring verification that every export has a matching import, every API endpoint has a consumer, auth gates protect all required routes, and at least one E2E flow traces through the full stack. See [verification/integration.md](./verification/integration.md).

**Plan checking** — Pre-execution verification of a plan across four dimensions: coverage, completeness, wiring, scope. See [verification/plan-checking.md](./verification/plan-checking.md).

**Scope sanity** — Threshold guard against over-scoped plans (1–3 tasks ideal; 5+ requires split). Part of plan checking. See [verification/plan-checking.md](./verification/plan-checking.md).

**Spec delta** — Scoped document capturing how a change modifies existing requirements. Linked via xBRIEF `references`. Lives in `history/changes/<name>/specs/`. See [context/spec-deltas.md](./context/spec-deltas.md).

**Verify command** — A concrete, runnable command per task that confirms the work is correct. Required by plan checking dimension 2.

---

## Framework Design Terms

**Bounded context** (framework sense) — A file or directory in directive that owns a specific rule domain. Other files reference it; they do not restate its rules.

**Rule ownership** — Each concept has exactly one owning file. Link to the owner rather than duplicating the rule.

**Ubiquitous language** — The shared vocabulary across all directive files. This glossary is the source of truth.

**Coding host** (host) · **skill pack** · **practice layer** · **orchestrator** — Buyer/evaluator category map. Canonical aid: [docs/CATEGORY.md](../docs/CATEGORY.md) (#2905).

---

## Hygiene Terms

**Hygiene** — Keeping a codebase clean beyond what individual changes introduce: dead code, circular deps, hidden errors, legacy paths. See [coding/hygiene.md](./coding/hygiene.md).

**Dead code** — Code defined but never executed.

**Error hiding** — Patterns that prevent errors from being observed by the caller or operator.

**Legacy code** — Superseded path not yet removed.

**Circular dependency** — Import cycle A→B→A (directly or transitively).

---

## GSD → Deft Term Mapping

| GSD Term | Deft Term | Notes |
|----------|-----------|-------|
| Milestone | **Release** | Shippable version |
| Slice | **Feature** | Vertical capability with demo sentence |
| Task | **Task** | Same — add "fits in one context window" |
| Must-haves | **Acceptance criteria** | truths, artifacts, key links |
| Continue file | **Continue checkpoint** | `./xbrief/continue.xbrief.json` |
| Discuss phase | **Interview** (extended) | decision locking + Feynman |
| Boundary map | **Contract** (planning) | Extension of Contract-First |
| Wave execution | **Parallel group** | Speckit `[P]`/`[S]` markers |
| Research phase | **Research** | Already in speckit |

---

## xBRIEF Lifecycle Terms

Canonical vocabulary for the xBRIEF lifecycle. **xBRIEF** / `xbrief/` is the sole public current name (#2907). **vBRIEF** is legacy — see [UPGRADING.md — xBRIEF rename](./UPGRADING.md#xbrief-rename-2034--2110--2907).

- **Scope xBRIEF** -- A durable unit-of-work record, one per feature / bug / initiative, stored as `YYYY-MM-DD-slug.xbrief.json` inside a [lifecycle folder](#xbrief-lifecycle-terms). Primary work artifact (schema detail: [vbrief/vbrief.md](./vbrief/vbrief.md)).

- **Lifecycle folder** -- One of five subdirectories under `xbrief/`: `proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`. Folder location reflects (but does not define) `plan.status`. See [vbrief/vbrief.md](./vbrief/vbrief.md).

- **Plan-level narrative** -- A key under `plan.narratives` in an xBRIEF (e.g. `Description`, `Acceptance`, `Traces`). Plain strings only. See [vbrief/vbrief.md](./vbrief/vbrief.md).

- **Item-level narrative** -- A narrative string under `plan.items[].narrative` for one PlanItem. Plain strings only. See [vbrief/vbrief.md](./vbrief/vbrief.md).

- **Filename stem** -- The portion of an xBRIEF filename before `.xbrief.json`. Scope stems: `YYYY-MM-DD-<slug>`; speckit Phase 4: `YYYY-MM-DD-ip<NNN>-<slug>`. See [vbrief/vbrief.md](./vbrief/vbrief.md).

- **Cross-scope dependency** -- Dependency between two scope xBRIEFs at `plan.metadata.dependencies` (array of dependency IDs). See [vbrief/vbrief.md](./vbrief/vbrief.md).

- **Exit Commands** -- The seven deterministic `task scope:*` commands that transition a scope xBRIEF between lifecycle folders: `scope:promote`, `scope:activate`, `scope:complete`, `scope:cancel`, `scope:restore`, `scope:block`, `scope:unblock` (see [tasks/scope.yml](../tasks/scope.yml)).

- **Origin provenance** -- A `references` entry linking a scope xBRIEF to its origin issue / ticket / user-request. Required for ingestion dedup. See [vbrief/vbrief.md](./vbrief/vbrief.md).

- **Canonical narrative key** -- Reserved plan-level keys (`Description`, `Acceptance`, `Traces`) that tooling reads by name. See [vbrief/vbrief.md](./vbrief/vbrief.md).

- **Preparatory strategy** -- A [strategies/](./strategies/) workflow that gathers context without producing a spec directly (e.g. `research.md`, `discuss.md`, `map.md`).

- **Spec-generating strategy** -- A [strategies/](./strategies/) workflow that emits `xbrief/specification.xbrief.json` (and optionally scope xBRIEFs) as authoritative output.

- **Rendered export** -- A human-readable `.md` file (`SPECIFICATION.md`, `PRD.md`, `ROADMAP.md`) generated by `task *:render` from the underlying `.xbrief.json`. Read-only views; edit the source, not the export. See [UPGRADING.md](./UPGRADING.md).

- **Source of truth** -- The file tooling treats as authoritative. Current: `.xbrief.json` files under `xbrief/`; corresponding `.md` files are [rendered exports](#xbrief-lifecycle-terms).

- **Deterministic mode** -- Interaction shape for structured questions. Every deterministic-mode prompt MUST include `Discuss` and `Back` as the final two options (#767). Canonical rule: [`contracts/deterministic-questions.md`](./contracts/deterministic-questions.md).

- **Branch-protection policy** -- Controls direct commits to master/main. Typed flag `plan.policy.allowDirectCommitsToMaster` on `xbrief/PROJECT-DEFINITION.xbrief.json` (#746); default `false`. Surfaces: skill guards, `task verify:branch` + hooks (#747), CI `branch-gate`. Reconfigure via `task policy:*`. Emergency: `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`.

- **Policy audit log** -- Append-only ledger at `meta/policy-changes.log` for transitions of `allowDirectCommitsToMaster` (#746 / #747).

- **vBRIEF (legacy)** -- Historical name for xBRIEF / `xbrief/` work-state. On-disk `vbrief/`, `*.vbrief.json`, `x-vbrief/*` tokens, and `vbrief:*` task aliases remain read-accepted until `deft migrate:xbrief`. ⊗ Teach vBRIEF as the current product name. Authoritative map: [UPGRADING.md — xBRIEF rename](./UPGRADING.md#xbrief-rename-2034--2110--2907).
