# Design Philosophy

Core design principles that guide the Deft Directive framework.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [contracts/hierarchy.md](../contracts/hierarchy.md) | [main.md](../../main.md)

---

## Self-Improving, Not Self-Editing (#3164)

Directive improves **across merges** through issues, PRs, and quality gates. It does not rewrite live constitution rules mid-run (**propose-not-apply**).

Constitution (managed AGENTS.md, pinned skills, policy) stays gated. Playbook-tier prose (e.g. lessons) may stay agent-writable because it sits at the bottom of the Rule Authority ladder.

Full stance and MUST/MAY bullets: [main.md § Self-Improving, Not Self-Editing](../../main.md#self-improving-not-self-editing-3164). Parent epic #3179; safety-via-gates #1200; trajectory/refine #2741.

Host honesty when the **runtime** self-mutates or is REPL-first (file gates / pins cannot see host-kernel work): [host-surface-assumptions.md](../docs/host-surface-assumptions.md) (#3162). Does not reverse this stance.

## Gate Integrity (#3156)

When a gate fails, the fix MUST NOT be an edit to the gate. Fix the work under test, or change the gate via issue/PR + review (#3164 disposal). Refine-internal SkillOpt protection stays on #2436; this is the general product/process rule.

Full rule, evidence pointer (Factorio / Continual Harness), and non-goals: [gate-integrity.md](../docs/gate-integrity.md). Parent epic #3179.

---

## Deterministic > Probabilistic

Prefer deterministic components for repeatable actions over probabilistic ones.

### Definition

A **deterministic component** produces identical outputs for identical inputs -- fixed commands, schema validators, CI checks, Taskfile tasks. A **probabilistic component** (LLM inference) produces variable outputs for the same input due to sampling, temperature, and context-window drift.

! When an action can be expressed as a fixed, repeatable operation, implement it as a deterministic component.
~ Reserve LLM inference for reasoning, synthesis, and creative tasks where variability is acceptable or desirable.
⊗ Use LLM inference as a gate where consistent, auditable behavior is required.

### Rationale

Deterministic components are **verifiable** -- you can write a test that asserts exact output. They are **auditable** -- the same input always produces the same result, so failures are reproducible. They are **fast** -- no API latency, no token cost, no rate limits.

LLM inference is appropriate for understanding intent, synthesizing information across documents, generating novel content, and making judgment calls. It is not appropriate for gates that need consistent pass/fail behavior across runs.

### Examples from the Deft Framework

**Taskfile tasks** -- `task check` is a fixed, repeatable gate. It runs the same linters, the same test suite, with the same thresholds every time. An LLM cannot replace this because its judgment on "does this code pass lint?" would vary between runs.

**spec_validate.py** -- Deterministic schema validation replaces LLM judgment on whether a vBRIEF file conforms to the schema. The validator checks exact field names, types, and enum values. An LLM reviewing the same file might miss a subtle type violation or flag a false positive depending on context.

**CI workflows** -- GitHub Actions runs deterministic CI gates (lint, test, build) on every push. The pipeline does not ask an LLM "does this PR look good?" -- it runs fixed checks with binary pass/fail outcomes.

### Scope Note

This principle is documented here as a design reference. Broad application across the CLI, skills, and workflows is Phase 5 work. This document establishes the principle; it does not mandate immediate refactoring of existing components.
