# Plan Checking

Pre-execution verification — catch bad plans before they become bad code.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [verification/verification.md](./verification.md) | [contracts/boundary-maps.md](../contracts/boundary-maps.md) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) plan-checker model.

---

## Core Principle

A bad plan caught before execution is 10x cheaper than bad code caught after. Verify plans **will** achieve goals, not just that they look complete.

---

## When to Check

- ! Before executing any multi-task plan
- ~ Before executing single-task plans for high-risk features
- ? Skip for trivial tasks (single file, obvious change)

## 4 Verification Dimensions

### 1. Coverage — Every requirement has task(s)

- ! Extract requirements from the spec/PRD
- ! Verify each requirement maps to at least one task
- ! Flag requirements with zero coverage
- ⊗ One vague task covering multiple requirements ("implement auth" for login + logout + sessions)

### 2. Completeness — Every task has acceptance criteria + verify command

- ! Every task has observable acceptance criteria (truths, artifacts, key links)
- ! Every task producing code has a **verify command** — a specific command that proves it works
- ⊗ Tasks with only steps and no acceptance criteria
- ⊗ Tasks where "verify" is just "review the code"

**Verify command examples:**
```
verify: pytest tests/test_auth.py -v
verify: curl -s localhost:3000/api/health | jq .status
verify: task test:coverage  # must show ≥85%
```

### 3. Wiring — Artifacts are connected, not just created

- ! Check that planned artifacts import/consume each other
- ! Planned API routes have planned consumers (UI, CLI, tests)
- ! Planned components are imported in planned pages/routes
- ⊗ Isolated artifacts — a file that exists but nothing references it

### 4. Scope — Plan fits in context budget

- ~ **2–3 tasks per plan** is ideal
- ! **5+ tasks** in a single plan is a blocker — split it
- ~ **5–8 files** modified per plan is ideal
- ! **15+ files** in a single plan is a blocker — split it
- ! Complex work (auth, payments, data migrations) gets its own plan, not a subtask

---

## Plan Check Output

Record in `./vbrief/plan.vbrief.json` as a narrative on the plan item:

```
Coverage:    4/4 requirements covered ✓
Completeness: 3/3 tasks have verify commands ✓
Wiring:      2 key links verified ✓
Scope:       3 tasks, 7 files ✓
```

If any dimension fails: revise plan before execution.

---

## Anti-Patterns

- ⊗ Executing a plan that failed any dimension
- ⊗ Plans without verify commands ("we'll test it later")
- ⊗ One mega-plan for an entire feature (split into per-feature plans)
- ⊗ Checking plans after execution (defeats the purpose)
