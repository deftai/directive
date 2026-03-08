# Boundary Maps

Explicit interface contracts between work units — think interfaces before implementation.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [coding/coding.md](../coding/coding.md) (Contract-First) | [verification/verification.md](../verification/verification.md) (Key Links) | [core/glossary.md](../core/glossary.md)

> Adapted from [GSD](https://github.com/gsd-build/get-shit-done) boundary map model. Extends Deft's Contract-First principle to the planning level.

---

## Core Principle

When planning multi-feature work, every feature declares **what it produces** and **what it consumes** from upstream — with concrete names. No vague references. No silent assumptions.

---

## Boundary Map Format

```
Feature 1 → Feature 2
  Produces:
    types.ts → User, Session, AuthToken (interfaces)
    auth.ts  → generateToken(), verifyToken(), refreshToken()
  Consumes: nothing (leaf node)

Feature 2 → Feature 3
  Produces:
    api/auth/login.ts  → POST handler
    middleware.ts       → authMiddleware()
  Consumes from Feature 1:
    auth.ts → generateToken(), verifyToken()
```

## Rules

- ! Every feature declares **produces** — functions, types, endpoints, with names
- ! Every feature declares **consumes** — what it needs from upstream, with source paths
- ! Leaf nodes (no upstream) explicitly state `Consumes: nothing`
- ! Before planning a downstream feature, **verify** that upstream actually produced what the map claims
- ⊗ Planning downstream work based on assumed/hoped-for upstream outputs
- ⊗ Vague produces ("auth module") — name the exports

## Verification at Boundaries

- ! On feature completion, check that all declared **produces** actually exist and are exported
- ! Before starting a consuming feature, check that declared **consumes** are importable
- ~ Use static verification (Tier 1 from [verification.md](../verification/verification.md)) for boundary checks
- ~ Flag mismatches immediately — don't let downstream work start on a broken contract

## vBRIEF Integration

- ~ Record boundary maps as narratives on the plan item in `./vbrief/plan.vbrief.json`
- ~ Use vBRIEF `blocks` edges in `./vbrief/plan.vbrief.json` to express produces/consumes dependencies
- ~ On boundary verification failure, set downstream items to `blocked` in `./vbrief/plan.vbrief.json` with narrative

---

## Anti-Patterns

- ⊗ "Feature 3 needs a function that feature 1 never exported"
- ⊗ Guessing what upstream built instead of checking the boundary map
- ⊗ Horizontal features ("implement the database layer") — prefer vertical features with demo sentences
- ⊗ Boundary maps without concrete names (functions, types, endpoints)
