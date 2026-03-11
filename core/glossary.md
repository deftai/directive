# Glossary

Terms used across the Deft framework. Includes mappings from external systems.

---

## Deft Work Decomposition Hierarchy

```
Release          ← Shippable version (one or more features)
  └── Feature    ← Independently demo-able vertical capability
       └── Task  ← Context-window-sized unit of work
```

**Release** — A shippable version of the product. Contains one or more features. Maps to a git tag and a CHANGELOG entry. See [versioning.md](./versioning.md).

**Feature** — An independently demo-able vertical capability. Scoped by a **demo sentence**: "After this, the user can ___." If you can't fill in that blank with something a human can observe, the feature is scoped wrong. Features are vertical (user-visible) not horizontal ("implement the database layer").

**Task** — The atomic unit of work. Must fit in one agent context window. If it doesn't fit, it's two tasks. This is an iron rule — violating it is where agents lose coherence.

---

## Terms Introduced by Deft (with GSD lineage)

These concepts originate from [GSD](https://github.com/gsd-build/get-shit-done) and have been adapted into the Deft framework.

**Anchor pruning** — Giving each task a fresh context window by pruning prior tasks' tool calls, intermediate reads, and debugging traces. Eliminates context rot. See [resilience/context-pruning.md](../resilience/context-pruning.md).

**Context rot** — The silent degradation of agent reasoning quality as the context window fills with stale tool output, dead-end debugging, and outdated file reads from prior tasks. By task 3–4 in a sequence, signal-to-noise has collapsed.

**Decision locking** — Decisions made during the discuss/interview phase are recorded in a context file and treated as **locked** for all downstream work. Downstream tasks inherit them — they don't re-debate. See [strategies/discuss.md](../strategies/discuss.md).

**Demo sentence** — The scoping test for a feature: "After this, the user can ___." If the blank can't be filled with something a human can observe, the feature is scoped wrong.

**Fractal summaries** — Hierarchical memory compression: task summaries compress into feature summaries, which compress into release summaries. Iron rule: never summarize summaries — regenerate each level from the level below + code state. See [context/fractal-summaries.md](../context/fractal-summaries.md).

**Specification vbrief** — The source-of-truth pattern for project intent. `./vbrief/specification.vbrief.json` is the canonical specification file; `SPECIFICATION.md` is a generated artifact rendered from it. The spec vbrief is created via interview (`templates/make-spec.md`), reviewed by the user, approved (`status: approved`), then rendered. Never edit the `.md` directly — edit the source vbrief. See [vbrief/vbrief.md](../vbrief/vbrief.md).

**Stub detection** — Scanning completed code for incomplete implementations: `TODO`/`FIXME` markers, `return null`/`return {}`/`pass` placeholders, functions under ~8 lines returning hardcoded values. See [verification/verification.md](../verification/verification.md).

**Verification ladder** — A 4-tier model for verifying agent work, picking the strongest tier reachable: (1) Static — files exist, exports present, no stubs. (2) Command — tests pass, build succeeds. (3) Behavioral — flows work, APIs respond correctly. (4) Human — manual verification only when tiers 1–3 can't confirm. See [verification/verification.md](../verification/verification.md).

**Zero discovery calls** — The principle that agents should never spend tokens figuring out where they are, what exists, or what was decided. All of that should be pre-assembled in context before the task starts. See [resilience/context-pruning.md](../resilience/context-pruning.md).

**Brownfield mapping** — Structured reconnaissance of an existing codebase before modifying it. Produces four artifacts: STACK (languages, frameworks, infrastructure), ARCHITECTURE (layers, entry points, data flow), CONVENTIONS (naming, patterns, file layout), and CONCERNS (tech debt, fragile areas, missing tests). See [strategies/map.md](../strategies/map.md). Invoked via `/deft:run:map`.

**Integration checking** — Cross-feature wiring verification that every export has a matching import, every API endpoint has a consumer, auth gates protect all required routes, and at least one E2E flow traces through the full stack. See [verification/integration.md](../verification/integration.md).

**Plan checking** — Pre-execution verification of a plan across four dimensions: (1) coverage — every acceptance criterion maps to at least one task, (2) completeness — every task has a verify command, (3) wiring — cross-feature dependencies declared in boundary maps, (4) scope — task count within sanity thresholds (2–3 ideal, 5+ requires split). See [verification/plan-checking.md](../verification/plan-checking.md).

**Scope sanity** — A threshold-based guard against over-scoped plans that degrade context window quality. 1–3 tasks per plan is ideal; 4 is a warning; 5+ is a blocker requiring plan split. Part of plan checking dimension 4. See [verification/plan-checking.md](../verification/plan-checking.md).

**Spec delta** — A scoped document capturing how a change modifies existing requirements. Shows new requirements and was/now diffs for modified ones. Linked to the baseline spec via vBRIEF `references` with `type: "x-vbrief/plan"`. Lives in `history/changes/<name>/specs/`. See [context/spec-deltas.md](../context/spec-deltas.md). Invoked as part of `/deft:change`.

**Verify command** — A concrete, runnable command specified per task that confirms the task's work is correct (e.g., `pytest tests/test_auth.py`, `curl localhost:8080/health`). Required by plan checking dimension 2 (completeness). Tasks without a verify command fail the plan check.

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
