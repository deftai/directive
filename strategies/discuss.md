# Discuss Strategy

Structured alignment before planning — front-load decisions, prevent drift.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [strategies/interview.md](./interview.md) (Phase 1: Interview) | [strategies/speckit.md](./speckit.md) (Phase 2: Specify) | [core/glossary.md](../core/glossary.md)

> Extends Deft's Interview phase with decision locking and Feynman technique. Adapted from [GSD](https://github.com/gsd-build/get-shit-done) discuss phase.

---

## Core Principle

The most expensive mistake is building the wrong thing. A 10-minute alignment conversation saves hours of re-implementation. Decisions made here flow through the entire pipeline — planning, execution, verification — and are **never re-debated** downstream.

---

## When to Use

- ! Before planning any feature/phase with gray areas
- ~ Before any feature where multiple reasonable approaches exist
- ? Skip only when the path forward is unambiguous and the user confirms

## The Feynman Approach

Use the Feynman technique: if the user (or you) can't explain the feature in simple, concrete terms, the understanding isn't there yet.

- ! **Make the abstract concrete** — "Walk me through using this." "What does that look like on screen?" "What happens when this fails?"
- ! **Explain it back** — Restate the user's intent in your own words. If the restatement surprises them, the spec is wrong.
- ! **Find the gaps** — Where the explanation gets hand-wavy is where the bugs will be.
- ~ Use the "teach it to a child" filter: if the expected behavior can't be described without jargon, it's underspecified.

## Questioning Behaviors

### Follow Energy

- ~ Whatever the user emphasizes, dig deeper into that
- ⊗ Robotically marching through a predetermined question list
- ~ If the user spends time on error handling, ask deeper questions about error handling

### Challenge Vagueness

- ! Push back on fuzzy answers: "Make it simple" → "Simple how? For the user? To implement? To extend later?"
- ! Push back on assumed agreement: "Standard auth" → "JWT with refresh? Server-side sessions? OAuth? Which standard?"
- ⊗ Accept fuzzy input — it produces divergent output

### Scope Guardrails

- ! If the user suggests a capability belonging to a different feature, capture it as **deferred**
- ~ Redirect: "That sounds like a new capability — I'll note it. For now, let's focus on [current scope]."
- ~ Record deferred ideas in `./vbrief/plan.vbrief.json` with `deferred` status and a narrative explaining why

## Domain-Sensitive Questions

Adapt question focus to what's being built:

- **Visual features** → Layout, density, interactions, empty states
- **APIs/CLIs** → Response format, flags, error handling, verbosity
- **Data systems** → Schema, validation, migration, edge cases
- **Organization tasks** → Grouping criteria, naming, duplicates, exceptions

## Output

- ! Produce a `{scope}-context.md` file with structured decisions and reasoning
- ! Each decision includes: **what** was decided, **why**, and **alternatives considered**
- ! This file is injected into all downstream work: planning, execution, verification
- ~ Persist decisions as vBRIEF narratives on the relevant plan items

## Decision Locking

- ! Decisions in context.md are **locked** — downstream tasks inherit them, don't re-debate
- ! If a locked decision needs revisiting, explicitly flag it as unlocked with justification
- ⊗ Silently making a different choice because the agent forgot what was decided
- ⊗ Re-debating a settled decision without explicit user approval

---

## Then: Chaining Gate

After alignment is complete and decisions are locked in `{scope}-context.md`,
return to the [chaining gate](./interview.md#chaining-gate) so the user can
run additional preparatory strategies or proceed to spec generation.

- ! On completion, register artifacts in `./vbrief/plan.vbrief.json`:
  - Update `completedStrategies`: increment `runCount` for `"discuss"`,
    append artifact path (`{scope}-context.md`)
  - Append the path to the flat `artifacts` array
- ! Return to [interview.md Chaining Gate](./interview.md#chaining-gate)
  (the discuss phase replaces the interview's question-gathering — decisions are
  already made, so the interview will be short or skipped entirely)
- ! The locked decisions from `{scope}-context.md` MUST flow into subsequent
  strategies and spec generation
- ⊗ End the session after discuss without returning to the chaining gate

---

## Workflow

1. **Open** -- Start with the user's goal statement; restate it in your own words
2. **Explore** -- Follow energy, challenge vagueness, ask domain-sensitive questions
3. **Lock** -- Record each decision in `{scope}-context.md` with what/why/alternatives
4. **Verify** -- Explain the full picture back to the user (Feynman check)
5. **Chain** -- Return to [interview.md Chaining Gate](./interview.md#chaining-gate)

## Anti-Patterns

- ⊗ Skipping discuss and immediately writing code
- ⊗ Asking generic checklist questions instead of following energy
- ⊗ Accepting "make it nice" / "standard approach" / "whatever works" without pushback
- ⊗ Scope creep — capturing out-of-scope ideas inline instead of deferring
- ⊗ Decisions that exist only in conversation history (they must be in context.md)
- ⊗ Ending after discuss without chaining into specification generation
