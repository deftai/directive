# Design Philosophy

Core design principles that guide the Deft Directive framework.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [contracts/hierarchy.md](../contracts/hierarchy.md) | [main.md](../main.md)

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
